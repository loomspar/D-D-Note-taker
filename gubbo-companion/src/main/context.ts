// Connects the existing Gubbo project: a local folder that is indexed in place, or imported files.
import fs from 'node:fs';
import path from 'node:path';
import type { Store } from './store';

const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.json', '.csv', '.yaml', '.yml', '.html']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'release', '.obsidian', '$RECYCLE.BIN', 'System Volume Information']);
const MAX_FILE = 600_000;
const MAX_FILES = 3000;
export const NOTES_DIR = 'Gubbo Companion Notes';

export function isTextFile(file: string): boolean { return TEXT_EXT.has(path.extname(file).toLowerCase()); }

function walk(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < MAX_FILES) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(full); }
      else if (e.isFile() && isTextFile(e.name)) out.push(full);
    }
  }
  return out;
}

/**
 * Re-index a user-selected folder. Only that folder is read. Files changed outside the app are picked
 * up by modification time; files that disappeared are dropped from the index. Originals are never written.
 */
export function scanFolder(store: Store, root: string): { indexed: number; updated: number; removed: number; skipped: number } {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error('That folder is not available right now.');
  const known = new Map(store.listContextDocs().filter((d) => d.source === 'folder').map((d) => [d.path, d]));
  let updated = 0, skipped = 0;
  const seen = new Set<string>();
  for (const file of walk(root)) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    let st: fs.Stats;
    try { st = fs.statSync(file); } catch { continue; }
    if (st.size > MAX_FILE) { skipped++; continue; }
    seen.add(rel);
    const mtime = st.mtime.toISOString();
    if (known.get(rel)?.mtime === mtime) continue;
    try { store.upsertContextDoc('folder', rel, path.basename(rel), fs.readFileSync(file, 'utf8'), mtime); updated++; } catch { skipped++; }
  }
  let removed = 0;
  for (const [rel, d] of known) if (!seen.has(rel)) { store.removeContextDoc(d.id); removed++; }
  return { indexed: seen.size, updated, removed, skipped };
}

/** Import copies of user-chosen files (Claude project instructions, knowledge files, chat summaries). */
export function importFiles(store: Store, files: string[]): { imported: string[]; rejected: { file: string; why: string }[] } {
  const imported: string[] = [], rejected: { file: string; why: string }[] = [];
  for (const file of files) {
    const name = path.basename(file);
    try {
      if (!isTextFile(file)) { rejected.push({ file: name, why: 'Only text files (Markdown, TXT, JSON, CSV, HTML) can be imported. Export other formats as text first.' }); continue; }
      const st = fs.statSync(file);
      if (st.size > MAX_FILE) { rejected.push({ file: name, why: 'Larger than 600 KB.' }); continue; }
      store.upsertContextDoc('import', file, name, fs.readFileSync(file, 'utf8'), st.mtime.toISOString());
      imported.push(name);
    } catch (e) { rejected.push({ file: name, why: (e as Error).message }); }
  }
  return { imported, rejected };
}

/** Re-read every imported file from where it was imported. Missing originals keep their last copy. */
export function refreshImports(store: Store): { refreshed: number; missing: string[] } {
  let refreshed = 0; const missing: string[] = [];
  for (const d of store.listContextDocs().filter((x) => x.source === 'import')) {
    if (d.path.startsWith('pasted:')) continue;
    try {
      const st = fs.statSync(d.path);
      store.upsertContextDoc('import', d.path, d.title, fs.readFileSync(d.path, 'utf8'), st.mtime.toISOString());
      refreshed++;
    } catch { missing.push(d.title); }
  }
  return { refreshed, missing };
}

export function importPasted(store: Store, title: string, text: string): void {
  const t = title.trim().slice(0, 120) || 'Pasted context';
  if (!text.trim()) throw new Error('Nothing was pasted.');
  if (text.length > MAX_FILE) throw new Error('That text is too long to import in one piece.');
  store.upsertContextDoc('import', `pasted:${t}`, t, text, null);
}

const safeName = (s: string) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'note';

/**
 * Write an assistant-generated note into "<Gubbo folder>/Gubbo Companion Notes". An existing file is
 * moved to a dated revision first; nothing outside that subfolder is ever written.
 */
export function writeNoteToFolder(root: string, title: string, content: string, now = new Date()): string {
  const dir = path.join(root, NOTES_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safeName(title)}.md`);
  if (path.dirname(path.resolve(file)) !== path.resolve(dir)) throw new Error('Refusing to write outside the notes folder.');
  if (fs.existsSync(file)) {
    const rev = path.join(dir, 'revisions');
    fs.mkdirSync(rev, { recursive: true });
    fs.renameSync(file, path.join(rev, `${safeName(title)} ${now.toISOString().replace(/[:.]/g, '-')}.md`));
  }
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

/** Markdown bundle of everything worth carrying back into the Gubbo project in Claude. */
export function buildGubboExport(store: Store, rules: { version: string; scoring: string; longFormConstraints: string; shortsNotes: string }, now = new Date()): string {
  const L: string[] = [`# Gubbo Companion export`, ``, `Exported ${now.toISOString()} from the Gubbo Companion desktop app. Add this file to the Gubbo project's knowledge to bring it up to date.`, ``];
  L.push(`## Scoring rules (version ${rules.version})`, '', rules.scoring, '', rules.longFormConstraints, '', rules.shortsNotes, '');
  const mem = store.listMemory();
  const section = (title: string, kinds: string[]) => {
    const items = mem.filter((m) => kinds.includes(m.kind));
    if (!items.length) return;
    L.push(`## ${title}`, '');
    for (const m of items) L.push(`- ${m.text}${m.reason ? ` — why: ${m.reason}` : ''} _(${m.provenance === 'gavin' ? 'Gavin' : 'assistant suggestion, saved'}, ${m.updatedAt.slice(0, 10)})_`);
    L.push('');
  };
  section('Preferences', ['preference', 'fact']);
  section('Accepted decisions', ['accepted']);
  section('Rejected ideas and why', ['rejected']);
  section('Tentative lessons', ['lesson']);
  section('Next actions', ['next_action']);
  for (const v of store.listVideos()) {
    L.push(`## Video: ${v.title}`, '', `- Stage: ${v.stage}`, `- Format: ${v.format === 'short' ? 'Short' : 'Long-form'}`);
    if (v.publishedVideoId) L.push(`- Published: https://www.youtube.com/watch?v=${v.publishedVideoId}`);
    if (v.premise) L.push('', v.premise);
    for (const s of store.listScores(v.id).slice(0, 1)) {
      const c = s.components;
      L.push('', `Latest Gubbo score (${s.createdAt.slice(0, 10)}, rules ${s.rulesVersion}): **${s.displayTotal}/100** — clarity ${c.clarity}, emotion ${c.emotion}, depth ${c.depth}, demand ${c.demand}, originality ${c.originality}. Weakest: ${s.weakest}`);
    }
    const src = store.listSources(v.id);
    if (src.length) { L.push('', 'Research sources:'); for (const s of src) L.push(`- [${s.title}](${s.url})${s.publishedDate ? ` (${s.publishedDate})` : ''}${s.note ? ` — ${s.note}` : ''}`); }
    for (const d of store.listDocuments(v.id)) {
      const full = store.getDocument(d.id)!;
      L.push('', `### ${d.title} (${d.kind.replace(/_/g, ' ')}, v${d.version})`, '', full.content);
    }
    L.push('');
  }
  return L.join('\n');
}
