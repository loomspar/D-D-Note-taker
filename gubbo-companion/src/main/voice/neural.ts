// Natural-sounding speech generated on this PC with the open Kokoro model (Apache-2.0), through
// kokoro-js and ONNX Runtime. One 89 MB download; after that it works offline and costs nothing.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const MODEL_FILE = 'onnx/model_quantized.onnx';
const MODEL_BYTES = 92_361_116;
const MODEL_SHA256 = 'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478';

export const NEURAL_VOICES: { id: string; label: string }[] = [
  { id: 'am_michael', label: 'Michael — American, warm' },
  { id: 'am_fenrir', label: 'Fenrir — American, deeper' },
  { id: 'am_onyx', label: 'Onyx — American, deep and calm' },
  { id: 'am_puck', label: 'Puck — American, lively' },
  { id: 'am_adam', label: 'Adam — American, low' },
  { id: 'am_eric', label: 'Eric — American' },
  { id: 'am_liam', label: 'Liam — American, younger' },
  { id: 'am_echo', label: 'Echo — American' },
  { id: 'bm_george', label: 'George — British, mature' },
  { id: 'bm_fable', label: 'Fable — British, storyteller' },
  { id: 'bm_daniel', label: 'Daniel — British' },
  { id: 'bm_lewis', label: 'Lewis — British, deep' },
  { id: 'af_heart', label: 'Heart — American, female' },
  { id: 'af_bella', label: 'Bella — American, female, bright' },
  { id: 'af_nicole', label: 'Nicole — American, female, soft' },
  { id: 'bf_emma', label: 'Emma — British, female' },
];
const VOICE_IDS = new Set(NEURAL_VOICES.map((v) => v.id));

export interface NeuralStatus { downloaded: boolean; loaded: boolean; downloadBytes: number; error: string | null }

export class NeuralVoice {
  private tts: any = null;
  private loading: Promise<void> | null = null;
  private error: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private cacheDir: string) {}

  private get modelPath() { return path.join(this.cacheDir, MODEL_ID, MODEL_FILE); }

  status(): NeuralStatus {
    let downloaded = false;
    try { downloaded = fs.statSync(this.modelPath).size === MODEL_BYTES; } catch { downloaded = false; }
    return { downloaded, loaded: !!this.tts, downloadBytes: downloaded ? 0 : MODEL_BYTES, error: this.error };
  }

  /** Download (first time only), verify the checksum, and load the model. Safe to call repeatedly. */
  prepare(onProgress?: (p: { received: number; total: number; step: string }) => void): Promise<void> {
    if (this.tts) return Promise.resolve();
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const wasDownloaded = this.status().downloaded;
        const { KokoroTTS } = await import('kokoro-js');
        const { env } = await import('@huggingface/transformers');
        env.cacheDir = this.cacheDir;
        env.allowLocalModels = false;
        const tts = await KokoroTTS.from_pretrained(MODEL_ID, {
          dtype: 'q8', device: 'cpu',
          progress_callback: (p: any) => { if (p?.status === 'progress' && String(p.file).endsWith('.onnx')) onProgress?.({ received: p.loaded ?? 0, total: p.total ?? MODEL_BYTES, step: 'Downloading the voice' }); },
        });
        if (!wasDownloaded) {
          const hash = crypto.createHash('sha256');
          for await (const chunk of fs.createReadStream(this.modelPath)) hash.update(chunk as Buffer);
          if (hash.digest('hex') !== MODEL_SHA256) {
            fs.rmSync(path.join(this.cacheDir, MODEL_ID), { recursive: true, force: true });
            throw new Error('The downloaded voice did not match its expected checksum, so it was deleted. Try again.');
          }
        }
        this.tts = tts; this.error = null;
      } catch (e) {
        this.error = (e as Error).message || 'The voice could not be loaded.';
        throw new Error(this.error);
      } finally { this.loading = null; }
    })();
    return this.loading;
  }

  /** One sentence-sized piece of text to 24 kHz mono samples. Requests run one at a time. */
  synth(text: string, voice: string, speed: number): Promise<{ pcm: Float32Array; sampleRate: number }> {
    const run = async () => {
      await this.prepare();
      const v = VOICE_IDS.has(voice) ? voice : 'am_michael';
      const audio = await this.tts.generate(text.slice(0, 500), { voice: v, speed: Math.min(1.6, Math.max(0.6, speed)) });
      return { pcm: audio.audio as Float32Array, sampleRate: audio.sampling_rate as number };
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

/** 16-bit PCM WAV, used by the self-test that feeds generated speech back through speech recognition. */
export function pcmToWav16k(pcm: Float32Array, sampleRate: number): Uint8Array {
  const ratio = sampleRate / 16000, n = Math.floor(pcm.length / ratio);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24); buf.writeUInt32LE(32000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    // Average the source samples that fall in this output sample (simple low-pass before decimating).
    const a = Math.floor(i * ratio), b = Math.max(a + 1, Math.floor((i + 1) * ratio));
    let sum = 0; for (let j = a; j < b; j++) sum += pcm[j];
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sum / (b - a))) * 32767), 44 + i * 2);
  }
  return buf;
}
