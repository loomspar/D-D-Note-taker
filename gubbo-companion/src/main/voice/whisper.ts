// Local speech-to-text with whisper.cpp. Binaries come from the project's official GitHub releases and
// models from its official Hugging Face repository; every download is checked against a pinned SHA-256.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WhisperStatus } from '../../shared/types';

const RELEASE = 'b5454'; // ggml-org/whisper.cpp build published 2026-10-06 (same commit as v1.9.5)
const BIN: Record<string, { url: string; sha256: string; bytes: number }> = {
  x64: { url: `https://github.com/ggml-org/whisper.cpp/releases/download/${RELEASE}/whisper-bin-x64.zip`, sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb', bytes: 8_930_000 },
  arm64: { url: `https://github.com/ggml-org/whisper.cpp/releases/download/${RELEASE}/whisper-bin-win-cpu-arm64.zip`, sha256: '28c37e7b598c3d9bbfef94f3bd67f2ee6f12b7c86f3da5edcf5e4308d615ff6d', bytes: 4_370_000 },
};
export const WHISPER_MODELS: Record<string, { url: string; sha256: string; bytes: number; label: string }> = {
  'tiny.en': { url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin', sha256: '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f', bytes: 77_704_715, label: 'Tiny (fastest, least accurate)' },
  'base.en': { url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin', sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002', bytes: 147_964_211, label: 'Base (good balance)' },
  'small.en': { url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin', sha256: 'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d', bytes: 487_614_201, label: 'Small (most accurate, slower)' },
};

/** Pick a model from the actual machine: transcription runs on the CPU, so cores and memory decide. */
export function recommendModel(cores: number, memGb: number): string {
  if (cores >= 8 && memGb >= 15) return 'small.en';
  if (cores >= 4 && memGb >= 7) return 'base.en';
  return 'tiny.en';
}

function findFile(dir: string, name: string): string | null {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === name) return full;
    if (e.isDirectory()) { const f = findFile(full, name); if (f) return f; }
  }
  return null;
}

export async function sha256File(file: string): Promise<string> {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** Download to a temp file, verify the hash, then move into place. A mismatch deletes the file. */
export async function downloadVerified(url: string, dest: string, sha256: string, onProgress: (received: number) => void, signal?: AbortSignal, fetchFn: typeof fetch = fetch): Promise<void> {
  const tmp = `${dest}.part`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await fetchFn(url, { redirect: 'follow', signal });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${new URL(url).host}.`);
  const out = fs.createWriteStream(tmp);
  const hash = crypto.createHash('sha256');
  let received = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk); received += chunk.length; onProgress(received);
      if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
  } catch (e) { out.destroy(); fs.rmSync(tmp, { force: true }); throw e; }
  if (hash.digest('hex') !== sha256) { fs.rmSync(tmp, { force: true }); throw new Error('The downloaded file did not match its expected checksum, so it was deleted. Try again; if it keeps happening the upstream file has changed and the app needs an update.'); }
  fs.renameSync(tmp, dest);
}

const run = (cmd: string, args: string[], opts: { timeoutMs: number; signal?: AbortSignal }): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, signal: opts.signal });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => p.kill(), opts.timeoutMs);
    p.stdout.on('data', (d) => (stdout += d)); p.stderr.on('data', (d) => (stderr += d));
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });

/** Remove whisper's non-speech markers such as [BLANK_AUDIO] or (wind blowing). */
export function cleanTranscript(raw: string): string {
  return raw.replace(/\[[^\]]*\]/g, ' ').replace(/\((?:[^)]{0,40})\)/g, ' ').replace(/\s+/g, ' ').trim();
}

export class Whisper {
  private busy: AbortController | null = null;
  constructor(private dir: string, private getModel: () => string) {}

  private get binDir() { return path.join(this.dir, 'bin', RELEASE); }
  private modelPath(model: string) { return path.join(this.dir, 'models', `ggml-${model}.bin`); }
  private cli(): string | null {
    if (process.env.GUBBO_WHISPER_CLI && fs.existsSync(process.env.GUBBO_WHISPER_CLI)) return process.env.GUBBO_WHISPER_CLI;
    return findFile(this.binDir, 'whisper-cli.exe');
  }

  status(): WhisperStatus {
    const model = this.getModel() in WHISPER_MODELS ? this.getModel() : 'base.en';
    const cpus = os.cpus();
    const cores = cpus.length, memGb = Math.round(os.totalmem() / 2 ** 30);
    const supported = (process.platform === 'win32' && process.arch in BIN) || !!process.env.GUBBO_WHISPER_CLI;
    const binaryReady = !!this.cli(), modelReady = fs.existsSync(this.modelPath(model));
    const bytes = (binaryReady ? 0 : BIN[process.arch]?.bytes ?? 0) + (modelReady ? 0 : WHISPER_MODELS[model].bytes);
    return {
      platformSupported: supported, binaryReady, modelReady, model, downloadBytes: bytes,
      cpu: cpus[0]?.model?.trim() ?? 'unknown CPU', cores, memGb, recommended: recommendModel(cores, memGb),
      note: supported ? 'Transcription runs on this PC’s processor. Nothing you say is sent to a speech service.' : 'Local transcription is set up for Windows (x64 or ARM64). On this system, type instead.',
    };
  }

  /** One-time download of the whisper.cpp program and the chosen model. */
  async download(onProgress: (p: { received: number; total: number; step: string }) => void): Promise<WhisperStatus> {
    if (this.busy) throw new Error('A download is already running.');
    const st = this.status();
    if (!st.platformSupported) throw new Error(st.note);
    const ctl = (this.busy = new AbortController());
    try {
      const total = st.downloadBytes;
      let base = 0;
      if (!st.binaryReady) {
        const b = BIN[process.arch];
        const zip = path.join(this.dir, 'bin', `${RELEASE}.zip`);
        await downloadVerified(b.url, zip, b.sha256, (r) => onProgress({ received: r, total, step: 'Downloading whisper.cpp' }), ctl.signal);
        fs.mkdirSync(this.binDir, { recursive: true });
        // tar.exe ships with Windows 10 and later and extracts zip archives.
        const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
        const r = await run(tar, ['-xf', zip, '-C', this.binDir], { timeoutMs: 120_000 });
        fs.rmSync(zip, { force: true });
        if (r.code !== 0 || !this.cli()) throw new Error(`Could not unpack whisper.cpp (${r.stderr.trim().slice(0, 200) || 'whisper-cli.exe not found in the archive'}).`);
        base = b.bytes;
      }
      if (!st.modelReady) {
        const m = WHISPER_MODELS[st.model];
        await downloadVerified(m.url, this.modelPath(st.model), m.sha256, (r) => onProgress({ received: base + r, total, step: `Downloading the ${st.model} speech model` }), ctl.signal);
      }
      return this.status();
    } finally { this.busy = null; }
  }
  cancelDownload(): void { this.busy?.abort(); }

  /** Transcribe 16 kHz mono PCM WAV bytes. The temp file is deleted whatever happens; audio is never kept. */
  async transcribe(wav: Uint8Array, signal?: AbortSignal): Promise<string> {
    const st = this.status();
    const cli = this.cli();
    if (!cli || !st.modelReady) throw new Error('Speech recognition is not downloaded yet. Finish voice setup in Settings → Voice.');
    if (wav.length < 44 + 16000 * 2 * 0.3) return '';
    if (wav.length > 44 + 16000 * 2 * 600) throw new Error('That recording is longer than ten minutes. Split it into shorter parts.');
    const tmpDir = path.join(this.dir, 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const file = path.join(tmpDir, `${crypto.randomUUID()}.wav`);
    fs.writeFileSync(file, wav);
    try {
      const threads = String(Math.max(1, Math.min(8, st.cores - 1)));
      const r = await run(cli, ['-m', this.modelPath(st.model), '-f', file, '-l', 'en', '-nt', '-np', '-t', threads], { timeoutMs: 180_000, signal });
      if (r.code !== 0) throw new Error(`Transcription failed (${r.stderr.trim().split('\n').pop()?.slice(0, 200) || `exit code ${r.code}`}).`);
      return cleanTranscript(r.stdout);
    } finally { fs.rmSync(file, { force: true }); }
  }

  /** Remove leftovers from a crash so raw audio never lingers on disk. */
  purgeTemp(): void { fs.rmSync(path.join(this.dir, 'tmp'), { recursive: true, force: true }); }
}
