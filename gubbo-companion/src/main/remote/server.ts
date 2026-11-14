// "Phone talks to my PC": a small HTTPS server on the home network that serves one page to Gavin's
// iPhone. The phone is only a microphone, a speaker and a screen — speech recognition, Claude, memory,
// the budget and the voice all stay on the PC. Off by default.
//
// Safeguards: private-network clients only; every request needs the pairing token (from the QR code);
// fixed routes only (no file paths from the client); bounded body sizes; one turn at a time.
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export interface RemoteDeps {
  pageDir: string;
  certFile: string;
  token: () => string;
  skinPng: () => Buffer | null;
  transcribe: (wav: Uint8Array) => Promise<string>;
  /** Runs one turn exactly as the desktop does (same budget gate, same memory). */
  runTurn: (text: string) => Promise<{ ok: boolean; reply: string }>;
  synth: (text: string) => Promise<Uint8Array | null>;
  onActivity?: (state: 'listening' | 'thinking' | 'speaking' | 'idle') => void;
}

export function isPrivateAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/, '').toLowerCase();
  if (a === '::1' || a.startsWith('fe80:') || a.startsWith('fc') || a.startsWith('fd')) return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(a);
  if (!m) return false;
  const [x, y] = [Number(m[1]), Number(m[2])];
  return x === 10 || x === 127 || (x === 192 && y === 168) || (x === 172 && y >= 16 && y <= 31) || (x === 169 && y === 254);
}

export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal && isPrivateAddress(i.address)) out.push(i.address);
  return out;
}

export function tokenMatches(given: string | undefined | null, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Split a reply into pieces the phone asks for one at a time, so speech starts quickly. */
export function speechParts(text: string, max = 260): string[] {
  const out: string[] = [];
  for (const s of text.match(/[^.!?]+[.!?]*\s*/g) ?? []) {
    const t = s.trim();
    if (!t) continue;
    if (out.length && out[out.length - 1].length + t.length < max) out[out.length - 1] += ` ${t}`; else out.push(t.slice(0, 500));
  }
  return out.slice(0, 40);
}

async function loadCert(file: string, ips: string[]): Promise<{ key: string; cert: string }> {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { key: string; cert: string; ips: string[] };
    if (ips.every((ip) => saved.ips.includes(ip))) return saved;
  } catch { /* create one */ }
  const selfsigned = await import('selfsigned');
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'Gubbo Companion (this PC)' }], {
    keySize: 2048, algorithm: 'sha256',
    extensions: [{ name: 'basicConstraints', cA: false }, { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, ...ips.map((ip) => ({ type: 7, ip }))] }],
  } as any);
  const out = { key: pems.private, cert: pems.cert, ips };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out), { mode: 0o600 });
  return out;
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/manifest+json', '.png': 'image/png' };
const STATIC = new Set(['index.html', 'phone.js', 'phone.css', 'manifest.json', 'icon.png']);

export class PhoneRemote {
  private server: https.Server | null = null;
  private busy = false;
  port = 0;
  error: string | null = null;

  constructor(private d: RemoteDeps) {}

  get running(): boolean { return !!this.server; }

  private ips: string[] = [];
  urls(): string[] { return this.running ? this.ips.map((ip) => `https://${ip}:${this.port}/?t=${this.d.token()}`) : []; }

  async start(preferredPort = 47800, ipsOverride?: string[]): Promise<void> {
    if (this.server) return;
    const ips = ipsOverride ?? lanAddresses();
    if (!ips.length) { this.error = 'This PC is not connected to a home network right now.'; throw new Error(this.error); }
    const { key, cert } = await loadCert(this.d.certFile, ips);
    const server = https.createServer({ key, cert }, (req, res) => void this.handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }));
    server.headersTimeout = 15_000; server.requestTimeout = 120_000;
    await new Promise<void>((resolve, reject) => {
      const tryPort = (p: number, left: number) => {
        server.once('error', (e: NodeJS.ErrnoException) => { if (e.code === 'EADDRINUSE' && left > 0) tryPort(p + 1, left - 1); else reject(e); });
        server.listen(p, '0.0.0.0', () => { this.port = p; resolve(); });
      };
      tryPort(preferredPort, 10);
    }).catch((e) => { this.error = `The phone link could not start (${(e as Error).message}).`; throw new Error(this.error); });
    this.server = server; this.ips = ips; this.error = null;
  }

  stop(): void { this.server?.close(); this.server?.closeAllConnections?.(); this.server = null; this.port = 0; }

  private authed(req: http.IncomingMessage, url: URL): boolean {
    const cookie = /(?:^|;\s*)gubbo=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    return tokenMatches(url.searchParams.get('t'), this.d.token()) || tokenMatches(cookie, this.d.token());
  }

  private body(req: http.IncomingMessage, limit: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []; let size = 0;
      req.on('data', (c: Buffer) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject);
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body: string | Uint8Array, type = 'application/json', extra: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...extra });
      res.end(body);
    };
    const json = (status: number, obj: unknown) => send(status, JSON.stringify(obj));
    if (!isPrivateAddress(req.socket.remoteAddress)) return send(403, 'Only available on the home network.', 'text/plain');
    const url = new URL(req.url ?? '/', 'https://gubbo.local');
    if (!this.authed(req, url)) return send(401, 'Open Gubbo Companion on the PC and scan the phone QR code again.', 'text/plain; charset=utf-8');
    const route = `${req.method} ${url.pathname}`;

    if (req.method === 'GET') {
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (name === 'skin.png') { const s = this.d.skinPng(); return s ? send(200, s, 'image/png') : send(404, ''); }
      if (!STATIC.has(name)) return send(404, 'Not found', 'text/plain');
      const csp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; manifest-src 'self'; base-uri 'none'; form-action 'none'";
      const cookie = `gubbo=${this.d.token()}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Strict`;
      return send(200, fs.readFileSync(path.join(this.d.pageDir, name)), TYPES[path.extname(name)] ?? 'application/octet-stream', name === 'index.html' ? { 'set-cookie': cookie, 'content-security-policy': csp } : {});
    }
    if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return send(403, 'Cross-site requests are not accepted.', 'text/plain');

    if (route === 'POST /api/talk' || route === 'POST /api/text') {
      if (this.busy) return json(409, { ok: false, reply: 'I’m still working on the last one.' });
      this.busy = true;
      try {
        let heard: string;
        if (route === 'POST /api/talk') {
          const wav = await this.body(req, 20 * 1024 * 1024);
          if (wav.length < 44 || wav.subarray(0, 4).toString('latin1') !== 'RIFF') return json(400, { ok: false, reply: 'That recording could not be read.' });
          this.d.onActivity?.('listening');
          heard = await this.d.transcribe(wav);
          if (!heard) return json(200, { ok: false, heard: '', reply: 'I didn’t catch any words. Try again.', parts: ['I didn’t catch any words. Try again.'] });
        } else {
          const parsed = JSON.parse((await this.body(req, 100_000)).toString('utf8')) as { text?: unknown };
          heard = typeof parsed.text === 'string' ? parsed.text.trim().slice(0, 8000) : '';
          if (!heard) return json(400, { ok: false, reply: 'Nothing was sent.' });
        }
        this.d.onActivity?.('thinking');
        const r = await this.d.runTurn(heard);
        return json(200, { ok: r.ok, heard, reply: r.reply, parts: speechParts(r.reply) });
      } catch (e) {
        return json(200, { ok: false, reply: (e as Error).message || 'Something went wrong on the PC.', parts: [] });
      } finally { this.busy = false; this.d.onActivity?.('idle'); }
    }
    if (route === 'POST /api/tts') {
      const parsed = JSON.parse((await this.body(req, 10_000)).toString('utf8')) as { text?: unknown };
      const text = typeof parsed.text === 'string' ? parsed.text.slice(0, 500) : '';
      const wav = text ? await this.d.synth(text) : null;
      return wav ? send(200, wav, 'audio/wav') : send(204, '');
    }
    return send(404, 'Not found', 'text/plain');
  }
}

/** 16-bit PCM WAV at the given rate, for playback on the phone. */
export function pcmToWav(pcm: Float32Array, sampleRate: number): Uint8Array {
  const buf = Buffer.alloc(44 + pcm.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + pcm.length * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[i])) * 32767), 44 + i * 2);
  return buf;
}
