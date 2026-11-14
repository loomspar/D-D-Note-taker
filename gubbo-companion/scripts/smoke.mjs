// Launches the app (built sources, or a packaged exe passed as the first argument) with GUBBO_SMOKE=1
// against a throwaway data folder, and prints the JSON report the app writes.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const exe = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : undefined;
// --voice <wav>: feed a WAV file to Chromium's fake microphone and run the spoken path end to end.
const vi = process.argv.indexOf('--voice');
const voiceWav = vi > 0 ? process.argv[vi + 1] : null;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gubbo-smoke-'));
const extra = process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu-sandbox'] : [];
if (voiceWav) extra.push('--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${path.resolve(voiceWav)}`);
const [cmd, args] = exe ? [exe, extra] : [createRequire(import.meta.url)('electron'), ['.', ...extra]];
const r = spawnSync(cmd, args, { env: { ...process.env, GUBBO_SMOKE: voiceWav ? 'voice' : '1', GUBBO_USER_DATA: dataDir }, encoding: 'utf8', timeout: voiceWav ? 400_000 : 90_000 });
const file = path.join(dataDir, 'smoke.json');
if (!fs.existsSync(file)) { console.error('No smoke report was written.\n', r.stdout?.slice(-2000), r.stderr?.slice(-2000)); process.exit(1); }
const report = JSON.parse(fs.readFileSync(file, 'utf8'));
console.log(JSON.stringify(report, null, 2));
if (voiceWav && process.env.GUBBO_SMOKE_OUT) fs.writeFileSync(process.env.GUBBO_SMOKE_OUT, JSON.stringify(report));
fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(report.ok ? 0 : 1);
