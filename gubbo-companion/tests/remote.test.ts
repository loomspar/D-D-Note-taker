import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PhoneRemote, isPrivateAddress, pcmToWav, speechParts, tokenMatches } from '../src/main/remote/server';
import { tmpDir } from './helpers';

const req = (port: number, method: string, p: string, opts: { body?: Buffer | string; headers?: Record<string, string> } = {}) =>
  new Promise<{ status: number; headers: Record<string, any>; body: Buffer }>((resolve, reject) => {
    const r = https.request({ host: '127.0.0.1', port, path: p, method, rejectUnauthorized: false, headers: opts.headers }, (res) => { const c: Buffer[] = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(c) })); });
    r.on('error', reject); if (opts.body) r.write(opts.body); r.end();
  });

describe('phone link', () => {
  const dir = tmpDir();
  const TOKEN = 'pairing-token-123456';
  const turns: string[] = [];
  const remote = new PhoneRemote({
    pageDir: path.join(__dirname, '..', 'assets', 'phone'), certFile: path.join(dir, 'cert.json'), token: () => TOKEN,
    skinPng: () => fs.readFileSync(path.join(__dirname, '..', 'assets', 'gubbo-skin.png')),
    transcribe: async (wav) => (wav.length > 100 ? 'how is my channel doing' : ''),
    runTurn: async (t) => { turns.push(t); return { ok: true, reply: 'First sentence. Second sentence here.' }; },
    synth: async (t) => pcmToWav(new Float32Array(240).fill(0.1), 24000),
  });
  beforeAll(async () => { await remote.start(47931, ['127.0.0.1']); }, 60_000);
  afterAll(() => { remote.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const cookie = { cookie: `gubbo=${TOKEN}` };

  it('refuses everything without the pairing token', async () => {
    expect((await req(remote.port, 'GET', '/')).status).toBe(401);
    expect((await req(remote.port, 'GET', '/?t=wrong')).status).toBe(401);
    expect((await req(remote.port, 'POST', '/api/text', { body: '{"text":"hi"}' })).status).toBe(401);
    expect(turns).toHaveLength(0);
  });
  it('serves the page with a strict policy and pairs by cookie', async () => {
    const r = await req(remote.port, 'GET', `/?t=${TOKEN}`);
    expect(r.status).toBe(200);
    expect(String(r.headers['set-cookie'])).toMatch(/HttpOnly; Secure; SameSite=Strict/);
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect((await req(remote.port, 'GET', '/phone.js', { headers: cookie })).status).toBe(200);
    expect((await req(remote.port, 'GET', '/skin.png', { headers: cookie })).headers['content-type']).toBe('image/png');
  });
  it('only serves its fixed files', async () => {
    for (const p of ['/../../package.json', '/..%2f..%2fpackage.json', '/secrets.json', '/index.html/../../x']) expect((await req(remote.port, 'GET', p, { headers: cookie })).status).toBe(404);
  });
  it('runs a typed and a spoken turn and returns speech in parts', async () => {
    const typed = JSON.parse((await req(remote.port, 'POST', '/api/text', { headers: cookie, body: JSON.stringify({ text: 'give me an idea' }) })).body.toString());
    expect(typed).toMatchObject({ ok: true, heard: 'give me an idea', parts: ['First sentence. Second sentence here.'] });
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(400)]);
    const spoken = JSON.parse((await req(remote.port, 'POST', '/api/talk', { headers: cookie, body: wav })).body.toString());
    expect(spoken.heard).toBe('how is my channel doing');
    expect(turns).toEqual(['give me an idea', 'how is my channel doing']);
    expect((await req(remote.port, 'POST', '/api/talk', { headers: cookie, body: Buffer.from('not audio at all, definitely not a wav file at all......') })).status).toBe(400);
    const audio = await req(remote.port, 'POST', '/api/tts', { headers: cookie, body: JSON.stringify({ text: 'Hello.' }) });
    expect(audio.headers['content-type']).toBe('audio/wav'); expect(audio.body.subarray(0, 4).toString()).toBe('RIFF');
  });
  it('rejects cross-site posts', async () => {
    expect((await req(remote.port, 'POST', '/api/text', { headers: { ...cookie, origin: 'https://evil.example' }, body: '{"text":"x"}' })).status).toBe(403);
  });
  it('recognises private addresses and compares tokens safely', () => {
    for (const a of ['192.168.1.20', '10.0.0.5', '172.16.9.1', '::ffff:192.168.0.7', '127.0.0.1', '::1', 'fe80::1']) expect(isPrivateAddress(a)).toBe(true);
    for (const a of ['8.8.8.8', '172.32.0.1', '193.168.1.1', '2001:4860::1', undefined]) expect(isPrivateAddress(a)).toBe(false);
    expect(tokenMatches('abc', 'abc')).toBe(true); expect(tokenMatches('abd', 'abc')).toBe(false); expect(tokenMatches('', 'abc')).toBe(false); expect(tokenMatches(null, 'abc')).toBe(false);
    expect(speechParts('One. Two! ' + 'Long sentence '.repeat(30) + '. Last?').length).toBeGreaterThan(1);
  });
});
