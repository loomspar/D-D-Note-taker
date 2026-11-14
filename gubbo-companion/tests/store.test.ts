import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateAccelerator } from '../src/main/accelerator';
import { NOTES_DIR, buildGubboExport, importFiles, scanFolder, writeNoteToFolder } from '../src/main/context';
import { openDb } from '../src/main/db';
import { clampToDisplays } from '../src/main/screen';
import { Secrets } from '../src/main/secrets';
import { SEED_RULES, displayScore, loadSettings, saveSettings } from '../src/main/settings';
import { validateSkinPng } from '../src/main/skin';
import { chunkForSpeech, shortSpoken, toSpeakable } from '../src/main/speechText';
import { Store } from '../src/main/store';
import { runTool, validateInput } from '../src/main/tools';
import { cleanTranscript, recommendModel } from '../src/main/voice/whisper';
import { tmpDir } from './helpers';

const mk = () => new Store(openDb(':memory:'));

describe('project workspace', () => {
  it('versions documents instead of overwriting, and can undo an edit', () => {
    const s = mk();
    const v = s.createVideo({ title: 'Test', premise: 'p', format: 'long' });
    const d = s.saveDocument({ videoId: v.id, kind: 'script', title: 'Script', content: 'v1', author: 'assistant' });
    s.saveDocument({ documentId: d.id, content: 'v2 by gavin', author: 'gavin' });
    const full = s.getDocument(d.id)!;
    expect(full.content).toBe('v2 by gavin');
    expect(full.versions.map((x) => x.content)).toEqual(['v2 by gavin', 'v1']);
    s.undo(s.undoList()[0].id);
    expect(s.getDocument(d.id)!.content).toBe('v1');
    expect(s.getDocument(d.id)!.versions).toHaveLength(2);       // history is kept
  });

  it('computes score totals itself and applies the 1–100 display rule', () => {
    const s = mk();
    const v = s.createVideo({ title: 'T' });
    const zero = s.addScore({ videoId: v.id, components: { clarity: 0, emotion: 0, depth: 0, demand: 0, originality: 0 }, weakest: 'everything', notes: '', rulesVersion: '1.0' });
    expect(zero.total).toBe(0); expect(zero.displayTotal).toBe(1);
    const sc = s.addScore({ videoId: v.id, components: { clarity: 18, emotion: 15, depth: 12, demand: 9, originality: 14 }, weakest: 'demand evidence is thin', notes: '', rulesVersion: '1.0' });
    expect(sc.displayTotal).toBe(68);
    expect(() => s.addScore({ videoId: v.id, components: { clarity: 21, emotion: 0, depth: 0, demand: 0, originality: 0 }, weakest: 'x', notes: '', rulesVersion: '1.0' })).toThrow();
    expect(displayScore(100)).toBe(100);
  });

  it('validates stages, sources and memory kinds', () => {
    const s = mk();
    const v = s.createVideo({ title: 'T' });
    expect(() => s.updateVideo(v.id, { stage: 'Shipped' })).toThrow();
    expect(s.updateVideo(v.id, { stage: 'Ready to record' }).stage).toBe('Ready to record');
    expect(() => s.addSource({ url: 'javascript:alert(1)', title: 'x', provenance: 'research' })).toThrow();
    expect(() => s.addSource({ url: 'https://youtu.be/abc', title: 'x', publishedDate: 'last week', provenance: 'research' })).toThrow();
    expect(() => s.addMemory({ kind: 'secret', text: 'x', provenance: 'gavin' })).toThrow();
  });

  it('retrieves snippets with their provenance, and reflects edits and deletions', () => {
    const s = mk();
    s.addMemory({ kind: 'preference', text: 'I prefer survival challenge formats over minigames', provenance: 'gavin' });
    const m = s.addMemory({ kind: 'lesson', text: 'Thumbnails with lava seemed to do better', provenance: 'assistant' });
    s.upsertContextDoc('import', 'C:/x/rules.md', 'rules.md', 'The Gubbo Virality Score rewards five-second clarity.', null);
    expect(s.search('What are my preferences about survival?')[0].provenance).toBe('gavin');
    expect(s.search('lava thumbnails')[0].provenance).toBe('assistant');
    expect(s.search('five-second clarity')[0].provenance).toBe('gubbo_import');
    s.updateMemory(m.id, { text: 'Thumbnails with obsidian seemed to do better' });
    expect(s.search('lava')).toHaveLength(0);
    expect(s.search('obsidian')[0].provenance).toBe('gavin');    // edited by Gavin → his statement
    s.deleteMemory(m.id);
    expect(s.search('obsidian')).toHaveLength(0);
    expect(s.search('"; DROP TABLE memory; --')).toEqual([]);
  });
});

describe('model tools', () => {
  const deps = () => { const store = mk(); return { store, settings: () => ({ rules: SEED_RULES }) as any, channelReport: () => ({ report: null, stale: false, connected: false }) }; };
  it('rejects extra fields, wrong types and unknown tools', () => {
    expect(() => validateInput('save_video_idea', { title: 'x', premise: 'y', format: 'long', path: 'C:/Windows' })).toThrow(/Unexpected/);
    expect(() => validateInput('get_video', { video_id: '1' })).toThrow();
    expect(() => validateInput('run_shell', {})).toThrow(/Unknown tool/);
    expect(runTool(deps(), 'delete_video', { video_id: 1 }).isError).toBe(true);    // no destructive tools exist
  });
  it('requires a reason for rejected ideas and never invents analytics', () => {
    const d = deps();
    expect(runTool(d, 'remember', { kind: 'rejected', text: 'x', stated_by_gavin: true }).isError).toBe(true);
    const a = JSON.parse(runTool(d, 'get_channel_analytics', {}).content);
    expect(a.available).toBe(false);
    const m = runTool(d, 'remember', { kind: 'preference', text: 'Maybe he likes redstone', stated_by_gavin: false });
    expect(m.isError).toBe(false);
    expect(d.store.listMemory()[0].provenance).toBe('assistant');
  });
});

describe('gubbo context', () => {
  it('indexes a chosen folder in place, follows outside edits, and only writes into its notes subfolder', () => {
    const dir = tmpDir(); const s = mk();
    fs.writeFileSync(path.join(dir, 'ideas.md'), 'Idea: one chunk survival');
    fs.mkdirSync(path.join(dir, 'node_modules')); fs.writeFileSync(path.join(dir, 'node_modules', 'junk.md'), 'junk');
    fs.writeFileSync(path.join(dir, 'photo.png'), 'not text');
    expect(scanFolder(s, dir)).toMatchObject({ indexed: 1, updated: 1 });
    expect(scanFolder(s, dir).updated).toBe(0);
    fs.writeFileSync(path.join(dir, 'ideas.md'), 'Idea: deep dark only'); fs.utimesSync(path.join(dir, 'ideas.md'), new Date(), new Date(Date.now() + 5000));
    expect(scanFolder(s, dir).updated).toBe(1);
    expect(s.search('deep dark')[0].provenance).toBe('gubbo_folder');
    expect(s.search('chunk')).toHaveLength(0);
    const f1 = writeNoteToFolder(dir, 'Recording: checklist?', 'first');
    writeNoteToFolder(dir, 'Recording: checklist?', 'second');
    expect(path.dirname(f1)).toBe(path.join(dir, NOTES_DIR));
    expect(fs.readFileSync(f1, 'utf8')).toBe('second');
    expect(fs.readdirSync(path.join(dir, NOTES_DIR, 'revisions'))).toHaveLength(1);   // the earlier note was kept
    expect(fs.readFileSync(path.join(dir, 'ideas.md'), 'utf8')).toBe('Idea: deep dark only');
    fs.rmSync(path.join(dir, 'ideas.md'));
    expect(scanFolder(s, dir).removed).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it('labels imports with their source and time, rejects non-text files, and exports decisions', () => {
    const dir = tmpDir(); const s = mk();
    fs.writeFileSync(path.join(dir, 'instructions.md'), 'Always score with the Gubbo rules'); fs.writeFileSync(path.join(dir, 'clip.mp4'), 'x');
    const r = importFiles(s, [path.join(dir, 'instructions.md'), path.join(dir, 'clip.mp4')]);
    expect(r.imported).toEqual(['instructions.md']); expect(r.rejected).toHaveLength(1);
    const doc = s.listContextDocs()[0];
    expect(doc.source).toBe('import'); expect(doc.path).toContain('instructions.md'); expect(Date.parse(doc.importedAt)).toBeGreaterThan(0);
    const v = s.createVideo({ title: 'Lava base', premise: 'Only lava' });
    s.addMemory({ kind: 'rejected', text: 'Water version', reason: 'Done to death', provenance: 'gavin', videoId: v.id });
    const md = buildGubboExport(s, SEED_RULES);
    expect(md).toContain('## Video: Lava base'); expect(md).toContain('Water version — why: Done to death'); expect(md).toContain('Gubbo Virality Score');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('settings, secrets and small validators', () => {
  it('keeps user-edited rules and clamps out-of-range values', () => {
    const db = openDb(':memory:');
    expect(loadSettings(db).rules.userEdited).toBe(false);
    const s = saveSettings(db, { rules: { scoring: 'My own rules' }, avatar: { size: 99999 }, voice: { rate: -3 }, bogus: { x: 1 } });
    expect(s.rules.userEdited).toBe(true); expect(loadSettings(db).rules.scoring).toBe('My own rules');
    expect(s.avatar.size).toBe(480); expect(s.voice.rate).toBe(0.5); expect((s as any).bogus).toBeUndefined();
    expect(s.hotkey).toBe('Control+Alt+G');
  });
  it('stores secrets encrypted in their own file, outside the database', () => {
    const dir = tmpDir(); const file = path.join(dir, 'secrets.json');
    const crypto = { isEncryptionAvailable: () => true, encryptString: (x: string) => Buffer.from(x.split('').reverse().join('')), decryptString: (b: Buffer) => b.toString().split('').reverse().join('') };
    const sec = new Secrets(file, crypto);
    sec.set('anthropicKey', 'sk-ant-api03-SECRETVALUE');
    expect(fs.readFileSync(file, 'utf8')).not.toContain('SECRETVALUE');
    expect(new Secrets(file, crypto).get('anthropicKey')).toBe('sk-ant-api03-SECRETVALUE');
    expect(() => new Secrets(file, { ...crypto, isEncryptionAvailable: () => false }).set('anthropicKey', 'x')).toThrow();
    const dbFile = path.join(dir, 'gubbo.db'); const db = openDb(dbFile); new Store(db).createVideo({ title: 'T' });
    const backup = path.join(dir, 'b.gubbo-backup'); db.prepare('VACUUM INTO ?').run(backup); db.close();
    expect(fs.readFileSync(backup).includes('SECRETVALUE')).toBe(false);
    expect(new Store(openDb(backup)).listVideos()).toHaveLength(1);     // a backup restores project data
    sec.clear('anthropicKey'); expect(sec.has('anthropicKey')).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it('accepts only real skin textures', () => {
    const png = (w: number, h: number) => { const b = Buffer.alloc(40); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
    expect(validateSkinPng(png(64, 64))).toEqual({ width: 64, height: 64, legacy: false });
    expect(validateSkinPng(png(64, 32)).legacy).toBe(true);
    expect(() => validateSkinPng(png(512, 512))).toThrow(/not the skin file/);
    expect(() => validateSkinPng(Buffer.from('GIF89a..............................'))).toThrow(/not a PNG/);
  });
  it('validates shortcuts and keeps the character on a connected display', () => {
    expect(validateAccelerator('Control+Alt+G')).toBe('Control+Alt+G');
    expect(() => validateAccelerator('G')).toThrow(); expect(() => validateAccelerator('Control+Alt')).toThrow(); expect(() => validateAccelerator('Control+Escape')).toThrow();
    const primary = { x: 0, y: 0, width: 1920, height: 1040 };
    expect(clampToDisplays({ x: 2500, y: 300, width: 220, height: 320 }, [primary, { x: 1920, y: 0, width: 1920, height: 1080 }], primary)).toEqual({ x: 2500, y: 300 });
    expect(clampToDisplays({ x: 2500, y: 300, width: 220, height: 320 }, [primary], primary)).toEqual({ x: 1920 - 220 - 24, y: 1040 - 320 - 24 });
    expect(clampToDisplays({ x: 1800, y: 900, width: 220, height: 320 }, [{ x: 0, y: 0, width: 1280, height: 680 }], { x: 0, y: 0, width: 1280, height: 680 }).x).toBe(1280 - 220 - 24);
  });
  it('reads prose aloud, not Markdown, URLs or code', () => {
    const spoken = toSpeakable('## Idea one\n\n**Strong** hook — see [this video](https://youtu.be/abc) and https://example.com/x.\n\n```js\nconsole.log(1)\n```\n\n- first point\n- second point\n\n| a | b |\n|---|---|\n| 1 | 2 |');
    expect(spoken).not.toMatch(/[#*`|]|https?:|console\.log/);
    expect(spoken).toContain('Idea one.'); expect(spoken).toContain('this video'); expect(spoken).toContain('first point');
    const long = 'Here is the short answer. '.repeat(3) + 'Then a very long script follows. '.repeat(40);
    expect(shortSpoken(long).length).toBeLessThan(480); expect(shortSpoken(long)).toMatch(/The rest is in the panel\.$/);
    expect(shortSpoken('Yes.')).toBe('Yes.');
    expect(chunkForSpeech('word '.repeat(200)).every((c) => c.length <= 221)).toBe(true);
  });
  it('cleans whisper output and picks a model from the hardware', () => {
    expect(cleanTranscript(' [BLANK_AUDIO] ')).toBe('');
    expect(cleanTranscript('Give me five ideas (wind blowing) for long-form.\n')).toBe('Give me five ideas for long-form.');
    expect(recommendModel(16, 32)).toBe('small.en'); expect(recommendModel(4, 8)).toBe('base.en'); expect(recommendModel(2, 4)).toBe('tiny.en');
  });
});
