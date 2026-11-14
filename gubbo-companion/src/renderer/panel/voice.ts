// Microphone capture and speech output for the panel window.
// Rules enforced here: the microphone opens only from an explicit user action, is released as soon as
// recording stops, raw audio is never stored, and recording and speech never overlap.
import { chunkForSpeech } from '../../main/speechText';
import type { Settings } from '../../shared/types';

export class MicError extends Error {
  constructor(message: string, public kind: 'denied' | 'no_device' | 'lost' | 'silence' | 'other') { super(message); }
}

/** 16-bit PCM mono WAV at 16 kHz — the format whisper.cpp expects. */
export function encodeWav(samples: Float32Array, sampleRate = 16000): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) { const s = Math.max(-1, Math.min(1, samples[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return buf;
}

export function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

export class Recorder {
  private stream: MediaStream | null = null;
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private lost = false;
  onLost: (() => void) | null = null;

  get recording(): boolean { return !!this.rec; }

  async start(deviceId: string | null): Promise<void> {
    if (this.rec) return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId ? { ideal: deviceId } : undefined, echoCancellation: true, noiseSuppression: true, channelCount: 1 }, video: false });
    } catch (e) {
      const name = (e as DOMException).name;
      if (name === 'NotAllowedError' || name === 'SecurityError') throw new MicError('Windows is blocking microphone access. Turn it on in Windows Settings → Privacy & security → Microphone (allow desktop apps), then try again. You can type in the meantime.', 'denied');
      if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new MicError('No microphone was found. Plug one in or pick another device in Settings → Voice. You can type in the meantime.', 'no_device');
      throw new MicError(`The microphone could not be opened (${name}).`, 'other');
    }
    this.chunks = []; this.lost = false;
    const track = this.stream.getAudioTracks()[0];
    track.addEventListener('ended', () => { if (this.rec) { this.lost = true; this.onLost?.(); } });
    this.rec = new MediaRecorder(this.stream);
    this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.start(250);
  }

  private release(): void {
    this.stream?.getTracks().forEach((t) => t.stop());   // frees the device; the Windows mic indicator goes off
    this.stream = null; this.rec = null;
  }

  /** Throw the recording away without transcribing it. */
  cancel(): void {
    if (!this.rec) return;
    try { this.rec.ondataavailable = null; this.rec.stop(); } catch { /* already stopped */ }
    this.chunks = []; this.release();
  }

  /** Stop, release the device, and return 16 kHz mono WAV bytes held only in memory. */
  async stop(): Promise<ArrayBuffer> {
    const rec = this.rec;
    if (!rec) throw new MicError('Nothing was being recorded.', 'other');
    const wasLost = this.lost;
    await new Promise<void>((resolve) => { rec.onstop = () => resolve(); try { rec.stop(); } catch { resolve(); } });
    const blob = new Blob(this.chunks, { type: rec.mimeType });
    this.chunks = []; this.release();
    if (wasLost && blob.size < 2000) throw new MicError('The microphone was disconnected before anything was recorded.', 'lost');
    if (blob.size < 1000) throw new MicError('I didn’t catch anything. Try again a little closer to the microphone.', 'silence');
    const ctx = new AudioContext();
    let decoded: AudioBuffer;
    try { decoded = await ctx.decodeAudioData(await blob.arrayBuffer()); } catch { throw new MicError('That recording could not be read.', 'other'); } finally { void ctx.close(); }
    const frames = Math.ceil(decoded.duration * 16000);
    if (frames < 16000 * 0.3) throw new MicError('That was too short to transcribe.', 'silence');
    const off = new OfflineAudioContext(1, frames, 16000);
    const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start();
    const samples = (await off.startRendering()).getChannelData(0);
    if (rms(samples) < 0.004) throw new MicError('I only heard silence. Check that the right microphone is selected and not muted.', 'silence');
    return encodeWav(samples);
  }
}

export function listVoices(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    const now = speechSynthesis.getVoices();
    if (now.length) return resolve(now);
    const done = () => resolve(speechSynthesis.getVoices());
    speechSynthesis.addEventListener('voiceschanged', done, { once: true });
    setTimeout(done, 2500);
  });
}

/**
 * Speech output. The default is the natural neural voice generated on this PC by the main process;
 * if it is not downloaded yet or fails, the installed Windows voices are used instead.
 */
export class Speaker {
  private token = 0;
  private ctx: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  /** Set when the neural voice could not be used, so the UI can say why a Windows voice is speaking. */
  lastFallback: string | null = null;

  stop(): void {
    this.token++;
    speechSynthesis.cancel();
    try { this.source?.stop(); } catch { /* not playing */ }
    this.source = null;
  }

  /** Resolves true when the whole text was spoken, false if it was interrupted. */
  async speak(text: string, v: Settings['voice'], onPart?: (part: string) => void): Promise<boolean> {
    this.stop();
    const my = this.token;
    const parts = chunkForSpeech(text, 260);
    if (!parts.length) return true;
    if (v.engine === 'neural') {
      const r = await this.speakNeural(parts, v, my, onPart);
      if (r !== 'unavailable') return r;
      if (my !== this.token) return false;
    }
    return this.speakWindows(parts, v, my, onPart);
  }

  private fetchPart(part: string, v: Settings['voice']): Promise<{ pcm: ArrayBuffer; sampleRate: number }> {
    return window.gubbo.invoke('tts:synth', { text: part, voice: v.neuralVoice, speed: v.rate }) as Promise<{ pcm: ArrayBuffer; sampleRate: number }>;
  }

  private async speakNeural(parts: string[], v: Settings['voice'], my: number, onPart?: (part: string) => void): Promise<boolean | 'unavailable'> {
    try {
      const st = (await window.gubbo.invoke('tts:status')) as { downloaded: boolean };
      if (!st.downloaded) { this.lastFallback = 'The natural voice has not been downloaded yet.'; return 'unavailable'; }
      this.ctx ??= new AudioContext();
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      const gain = this.ctx.createGain(); gain.gain.value = v.volume; gain.connect(this.ctx.destination);
      // Generate one sentence ahead so playback is continuous.
      let next = this.fetchPart(parts[0], v);
      for (let i = 0; i < parts.length; i++) {
        let audio: { pcm: ArrayBuffer; sampleRate: number };
        try { audio = await next; } catch (e) { if (i === 0) { this.lastFallback = (e as Error).message; return 'unavailable'; } throw e; }
        if (my !== this.token) return false;
        if (i + 1 < parts.length) next = this.fetchPart(parts[i + 1], v);
        const samples = new Float32Array(audio.pcm);
        const buf = this.ctx.createBuffer(1, samples.length, audio.sampleRate);
        buf.copyToChannel(samples, 0);
        onPart?.(parts[i]);
        const done = await new Promise<boolean>((resolve) => {
          const src = this.ctx!.createBufferSource();
          src.buffer = buf; src.connect(gain);
          src.onended = () => resolve(my === this.token);
          this.source = src; src.start();
        });
        if (!done) return false;
      }
      this.lastFallback = null;
      return my === this.token;
    } catch { return false; }
  }

  private async speakWindows(parts: string[], v: Settings['voice'], my: number, onPart?: (part: string) => void): Promise<boolean> {
    const voices = await listVoices();
    if (my !== this.token) return false;
    // Only local (installed) voices: Chromium can list online voices, which would be a network service.
    const local = voices.filter((x) => x.localService);
    if (!local.length) {
      // No installed voice: still show the words as captions, paced roughly like speech.
      for (const part of parts) { if (my !== this.token) return false; onPart?.(part); await new Promise((r) => setTimeout(r, 900 + part.length * 55)); }
      return my === this.token;
    }
    const voice = local.find((x) => x.name === v.voiceName) ?? local.find((x) => x.lang.startsWith('en')) ?? local[0];
    for (const part of parts) {
      if (my !== this.token) return false;
      onPart?.(part);
      const ok = await new Promise<boolean>((resolve) => {
        const u = new SpeechSynthesisUtterance(part);
        u.voice = voice; u.lang = voice.lang; u.rate = v.rate; u.pitch = v.pitch; u.volume = v.volume;
        u.onend = () => resolve(true); u.onerror = () => resolve(false);
        speechSynthesis.speak(u);
      });
      if (!ok) return false;
    }
    return my === this.token;
  }
}
