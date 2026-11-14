// Windows-only check of the offline voice path, without a microphone:
//   1. download whisper.cpp + the tiny model through the app's own verified downloader,
//   2. have an installed Windows voice speak a sentence into a 16 kHz mono WAV,
//   3. transcribe it with the app's Whisper class and compare.
import { build } from 'esbuild';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.platform !== 'win32') { console.log('Skipped: this check needs Windows.'); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gubbo-voice-'));
const out = path.join(dir, 'whisper.mjs');
await build({ entryPoints: ['src/main/voice/whisper.ts'], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' });
const { Whisper } = await import(pathToFileURL(out).href);

const whisper = new Whisper(path.join(dir, 'whisper'), () => 'tiny.en');
console.log('before:', whisper.status());
let lastStep = '';
await whisper.download((p) => { if (p.step !== lastStep) { lastStep = p.step; console.log(p.step); } });
const st = whisper.status();
if (!st.binaryReady || !st.modelReady) throw new Error('Download finished but whisper is not ready.');

const wav = path.join(dir, 'say.wav');
const sentence = 'Give me five long form video ideas that fit my recording budget.';
execFileSync('powershell', ['-NoProfile', '-Command', `
  Add-Type -AssemblyName System.Speech
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  "Installed voices: " + (($s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }) -join ', ')
  $f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $s.SetOutputToWaveFile('${wav}', $f)
  $s.Speak('${sentence}')
  $s.Dispose()`], { stdio: 'inherit' });

const started = Date.now();
const text = await whisper.transcribe(fs.readFileSync(wav));
console.log(`transcript (${Date.now() - started} ms): ${text}`);
if (fs.readdirSync(path.join(dir, 'whisper', 'tmp')).length) throw new Error('A temporary audio file was left behind.');
const norm = (s) => s.toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/).filter(Boolean);
const want = norm(sentence), got = new Set(norm(text));
const hit = want.filter((w) => got.has(w)).length / want.length;
console.log(`word match: ${Math.round(hit * 100)}%`);
if (hit < 0.7) { console.error('Transcript did not match the spoken sentence.'); process.exit(1); }

// 4. The same sentence through the packaged app's own microphone path, using Chromium's fake capture device.
const exe = process.argv[2];
if (exe) {
  const reportFile = path.join(dir, 'voice-smoke.json');
  const r = spawnSync(process.execPath, ['scripts/smoke.mjs', exe, '--voice', wav], { stdio: 'inherit', env: { ...process.env, GUBBO_SMOKE_OUT: reportFile } });
  const rep = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  const got2 = new Set(norm(rep.transcript ?? ''));
  const hit2 = want.filter((w) => got2.has(w)).length / want.length;
  console.log(`app microphone path word match: ${Math.round(hit2 * 100)}%  states: ${rep.stateSequence}`);
  if (r.status !== 0 || hit2 < 0.7) { console.error('The in-app spoken path did not produce the expected transcript.'); process.exit(1); }
}
fs.rmSync(dir, { recursive: true, force: true });
console.log('VOICE OK');
