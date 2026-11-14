// Project workspace, memory and search. Pure data layer over SQLite: no Electron imports.
import { DOC_KINDS, MEMORY_KINDS, STAGES } from '../shared/types';
import type { ContextDoc, DocKind, DocSummary, DocVersion, MemoryItem, MemoryKind, Provenance, Score, SearchHit, Source, Stage, UndoEntry, Video } from '../shared/types';
import { type DB, indexDelete, indexPut, nowIso, tx } from './db';
import { displayScore } from './settings';

type UndoOp =
  | { op: 'delete_video'; id: number }
  | { op: 'delete_memory'; id: number }
  | { op: 'delete_document'; id: number }
  | { op: 'revert_document'; id: number; toVersion: number }
  | { op: 'restore_video'; before: Video }
  | { op: 'delete_source'; id: number }
  | { op: 'delete_score'; id: number };

const str = (v: unknown, max: number, name: string, allowEmpty = false): string => {
  if (typeof v !== 'string') throw new Error(`${name} must be text.`);
  const s = v.trim();
  if (!allowEmpty && !s) throw new Error(`${name} is empty.`);
  if (s.length > max) throw new Error(`${name} is too long (max ${max} characters).`);
  return s;
};

export class Store {
  constructor(public db: DB) {}

  // ---------- undo ----------
  private pushUndo(label: string, ops: UndoOp[]): number {
    const r = this.db.prepare('INSERT INTO undo_log(label, ops, created_at) VALUES(?, ?, ?)').run(label, JSON.stringify(ops), nowIso());
    return Number(r.lastInsertRowid);
  }
  /** Run several store calls as one undoable batch. */
  batch<T>(label: string, fn: () => T): T {
    return tx(this.db, () => {
      const before = (this.db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM undo_log').get() as { m: number }).m;
      const out = fn();
      const rows = this.db.prepare('SELECT id, ops FROM undo_log WHERE id > ? ORDER BY id').all(before) as { id: number; ops: string }[];
      if (rows.length > 1) {
        const ops = rows.flatMap((r) => JSON.parse(r.ops) as UndoOp[]);
        this.db.prepare('DELETE FROM undo_log WHERE id > ?').run(before);
        this.pushUndo(label, ops);
      } else if (rows.length === 1) {
        this.db.prepare('UPDATE undo_log SET label = ? WHERE id = ?').run(label, rows[0].id);
      }
      return out;
    });
  }
  undoList(limit = 30): UndoEntry[] {
    return (this.db.prepare('SELECT id, label, created_at, undone FROM undo_log ORDER BY id DESC LIMIT ?').all(limit) as any[])
      .map((r) => ({ id: r.id, label: r.label, createdAt: r.created_at, undone: !!r.undone }));
  }
  undo(id: number): string {
    const row = this.db.prepare('SELECT * FROM undo_log WHERE id = ? AND undone = 0').get(id) as any;
    if (!row) throw new Error('Nothing to undo for that entry.');
    tx(this.db, () => {
      for (const op of (JSON.parse(row.ops) as UndoOp[]).reverse()) {
        if (op.op === 'delete_video') this.rawDeleteVideo(op.id);
        else if (op.op === 'delete_memory') this.rawDeleteMemory(op.id);
        else if (op.op === 'delete_document') this.rawDeleteDocument(op.id);
        else if (op.op === 'revert_document') this.rawRevertDocument(op.id, op.toVersion);
        else if (op.op === 'delete_source') this.db.prepare('DELETE FROM sources WHERE id = ?').run(op.id);
        else if (op.op === 'delete_score') this.db.prepare('DELETE FROM scores WHERE id = ?').run(op.id);
        else if (op.op === 'restore_video') {
          const b = op.before;
          this.db.prepare('UPDATE videos SET title=?, premise=?, format=?, stage=?, published_video_id=?, asset_links=?, updated_at=? WHERE id=?')
            .run(b.title, b.premise, b.format, b.stage, b.publishedVideoId, JSON.stringify(b.assetLinks), nowIso(), b.id);
          indexPut(this.db, 'video', b.id, b.title, b.premise);
        }
      }
      this.db.prepare('UPDATE undo_log SET undone = 1 WHERE id = ?').run(id);
    });
    return row.label as string;
  }

  // ---------- videos ----------
  private videoRow = (r: any): Video => ({ id: r.id, title: r.title, premise: r.premise, format: r.format, stage: r.stage, publishedVideoId: r.published_video_id, assetLinks: JSON.parse(r.asset_links), createdAt: r.created_at, updatedAt: r.updated_at });
  listVideos(): Video[] { return (this.db.prepare('SELECT * FROM videos ORDER BY updated_at DESC').all() as any[]).map(this.videoRow); }
  getVideo(id: number): Video | null { const r = this.db.prepare('SELECT * FROM videos WHERE id = ?').get(id); return r ? this.videoRow(r) : null; }
  createVideo(input: { title: unknown; premise?: unknown; format?: unknown; stage?: unknown }): Video {
    const title = str(input.title, 200, 'Title');
    const premise = input.premise === undefined ? '' : str(input.premise, 4000, 'Premise', true);
    const format = input.format === 'short' ? 'short' : 'long';
    const stage = STAGES.includes(input.stage as Stage) ? (input.stage as Stage) : 'Idea';
    const t = nowIso();
    const r = this.db.prepare('INSERT INTO videos(title, premise, format, stage, created_at, updated_at) VALUES(?,?,?,?,?,?)').run(title, premise, format, stage, t, t);
    const id = Number(r.lastInsertRowid);
    indexPut(this.db, 'video', id, title, premise);
    this.pushUndo(`Saved video idea “${title}”`, [{ op: 'delete_video', id }]);
    return this.getVideo(id)!;
  }
  updateVideo(id: number, patch: { title?: unknown; premise?: unknown; format?: unknown; stage?: unknown; publishedVideoId?: unknown; assetLinks?: unknown }): Video {
    const before = this.getVideo(id);
    if (!before) throw new Error(`There is no video with id ${id}.`);
    const next = { ...before };
    if (patch.title !== undefined) next.title = str(patch.title, 200, 'Title');
    if (patch.premise !== undefined) next.premise = str(patch.premise, 4000, 'Premise', true);
    if (patch.format !== undefined) { if (patch.format !== 'long' && patch.format !== 'short') throw new Error('Format must be "long" or "short".'); next.format = patch.format; }
    if (patch.stage !== undefined) { if (!STAGES.includes(patch.stage as Stage)) throw new Error(`Stage must be one of: ${STAGES.join(', ')}.`); next.stage = patch.stage as Stage; }
    if (patch.publishedVideoId !== undefined) {
      if (patch.publishedVideoId !== null && !/^[A-Za-z0-9_-]{6,20}$/.test(String(patch.publishedVideoId))) throw new Error('That does not look like a YouTube video ID.');
      next.publishedVideoId = patch.publishedVideoId as string | null;
    }
    if (patch.assetLinks !== undefined) {
      if (!Array.isArray(patch.assetLinks) || patch.assetLinks.length > 50) throw new Error('Asset links must be a list.');
      next.assetLinks = patch.assetLinks.map((a) => str(a, 500, 'Asset link'));
    }
    this.db.prepare('UPDATE videos SET title=?, premise=?, format=?, stage=?, published_video_id=?, asset_links=?, updated_at=? WHERE id=?')
      .run(next.title, next.premise, next.format, next.stage, next.publishedVideoId, JSON.stringify(next.assetLinks), nowIso(), id);
    indexPut(this.db, 'video', id, next.title, next.premise);
    this.pushUndo(`Updated “${before.title}”`, [{ op: 'restore_video', before }]);
    return this.getVideo(id)!;
  }
  private rawDeleteVideo(id: number): void {
    for (const d of this.db.prepare('SELECT id FROM documents WHERE video_id = ?').all(id) as { id: number }[]) this.rawDeleteDocument(d.id);
    for (const m of this.db.prepare('SELECT id FROM memory WHERE video_id = ?').all(id) as { id: number }[]) this.rawDeleteMemory(m.id);
    this.db.prepare('DELETE FROM sources WHERE video_id = ?').run(id);
    this.db.prepare('DELETE FROM scores WHERE video_id = ?').run(id);
    this.db.prepare('DELETE FROM videos WHERE id = ?').run(id);
    indexDelete(this.db, 'video', id);
  }
  /** Explicit user action only; never exposed as a model tool. */
  deleteVideo(id: number): void { tx(this.db, () => this.rawDeleteVideo(id)); }

  // ---------- documents with version history ----------
  private docRow = (r: any): DocSummary => ({ id: r.id, videoId: r.video_id, kind: r.kind, title: r.title, version: r.current_version, updatedAt: r.updated_at, author: r.author ?? '' });
  listDocuments(videoId: number | null): DocSummary[] {
    const sql = `SELECT d.*, (SELECT author FROM doc_versions v WHERE v.document_id = d.id AND v.version = d.current_version) AS author
      FROM documents d WHERE ${videoId === null ? 'd.video_id IS NULL' : 'd.video_id = ?'} ORDER BY d.updated_at DESC`;
    return ((videoId === null ? this.db.prepare(sql).all() : this.db.prepare(sql).all(videoId)) as any[]).map(this.docRow);
  }
  getDocument(id: number): { doc: DocSummary; content: string; versions: DocVersion[] } | null {
    const d = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as any;
    if (!d) return null;
    const versions = (this.db.prepare('SELECT * FROM doc_versions WHERE document_id = ? ORDER BY version DESC').all(id) as any[])
      .map((v) => ({ id: v.id, documentId: v.document_id, version: v.version, content: v.content, author: v.author, createdAt: v.created_at }));
    const cur = versions.find((v) => v.version === d.current_version);
    return { doc: this.docRow({ ...d, author: cur?.author }), content: cur?.content ?? '', versions };
  }
  /** Creates a document, or adds a new version when documentId is given. Old versions are never overwritten. */
  saveDocument(input: { documentId?: number | null; videoId?: number | null; kind?: unknown; title?: unknown; content: unknown; author: 'gavin' | 'assistant' }): DocSummary {
    const content = str(input.content, 400_000, 'Content', true);
    const t = nowIso();
    if (input.documentId) {
      const d = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(input.documentId) as any;
      if (!d) throw new Error(`There is no document with id ${input.documentId}.`);
      const max = (this.db.prepare('SELECT MAX(version) AS m FROM doc_versions WHERE document_id = ?').get(d.id) as { m: number }).m ?? 0;
      const title = input.title !== undefined ? str(input.title, 200, 'Title') : d.title;
      this.db.prepare('INSERT INTO doc_versions(document_id, version, content, author, created_at) VALUES(?,?,?,?,?)').run(d.id, max + 1, content, input.author, t);
      this.db.prepare('UPDATE documents SET current_version = ?, title = ?, updated_at = ? WHERE id = ?').run(max + 1, title, t, d.id);
      indexPut(this.db, 'document', d.id, title, content);
      this.pushUndo(`Edited “${title}” (v${max + 1})`, [{ op: 'revert_document', id: d.id, toVersion: d.current_version }]);
      return this.getDocument(d.id)!.doc;
    }
    if (!DOC_KINDS.includes(input.kind as DocKind)) throw new Error(`Document kind must be one of: ${DOC_KINDS.join(', ')}.`);
    const title = str(input.title, 200, 'Title');
    const videoId = input.videoId ?? null;
    if (videoId !== null && !this.getVideo(videoId)) throw new Error(`There is no video with id ${videoId}.`);
    const r = this.db.prepare('INSERT INTO documents(video_id, kind, title, current_version, updated_at) VALUES(?,?,?,1,?)').run(videoId, input.kind as string, title, t);
    const id = Number(r.lastInsertRowid);
    this.db.prepare('INSERT INTO doc_versions(document_id, version, content, author, created_at) VALUES(?,1,?,?,?)').run(id, content, input.author, t);
    indexPut(this.db, 'document', id, title, content);
    if (videoId !== null) this.db.prepare('UPDATE videos SET updated_at = ? WHERE id = ?').run(t, videoId);
    this.pushUndo(`Saved ${String(input.kind).replace(/_/g, ' ')} “${title}”`, [{ op: 'delete_document', id }]);
    return this.getDocument(id)!.doc;
  }
  private rawRevertDocument(id: number, toVersion: number): void {
    const v = this.db.prepare('SELECT content FROM doc_versions WHERE document_id = ? AND version = ?').get(id, toVersion) as { content: string } | undefined;
    const d = this.db.prepare('SELECT title FROM documents WHERE id = ?').get(id) as { title: string } | undefined;
    if (!v || !d) return;
    this.db.prepare('UPDATE documents SET current_version = ?, updated_at = ? WHERE id = ?').run(toVersion, nowIso(), id);
    indexPut(this.db, 'document', id, d.title, v.content);
  }
  /** Make an older version current again. History is kept. */
  revertDocument(id: number, toVersion: number): void { this.rawRevertDocument(id, toVersion); }
  private rawDeleteDocument(id: number): void {
    this.db.prepare('DELETE FROM doc_versions WHERE document_id = ?').run(id);
    this.db.prepare('DELETE FROM documents WHERE id = ?').run(id);
    indexDelete(this.db, 'document', id);
  }
  deleteDocument(id: number): void { tx(this.db, () => this.rawDeleteDocument(id)); }

  // ---------- memory ----------
  private memRow = (r: any): MemoryItem => ({ id: r.id, kind: r.kind, text: r.text, reason: r.reason, provenance: r.provenance, videoId: r.video_id, createdAt: r.created_at, updatedAt: r.updated_at });
  listMemory(filter?: { kind?: MemoryKind; videoId?: number }): MemoryItem[] {
    let rows = this.db.prepare('SELECT * FROM memory ORDER BY updated_at DESC').all() as any[];
    if (filter?.kind) rows = rows.filter((r) => r.kind === filter.kind);
    if (filter?.videoId !== undefined) rows = rows.filter((r) => r.video_id === filter.videoId);
    return rows.map(this.memRow);
  }
  addMemory(input: { kind: unknown; text: unknown; reason?: unknown; provenance: Provenance; videoId?: number | null }): MemoryItem {
    if (!MEMORY_KINDS.includes(input.kind as MemoryKind)) throw new Error(`Memory kind must be one of: ${MEMORY_KINDS.join(', ')}.`);
    const text = str(input.text, 4000, 'Memory text');
    const reason = input.reason === undefined || input.reason === null ? null : str(input.reason, 2000, 'Reason', true) || null;
    const videoId = input.videoId ?? null;
    if (videoId !== null && !this.getVideo(videoId)) throw new Error(`There is no video with id ${videoId}.`);
    const t = nowIso();
    const r = this.db.prepare('INSERT INTO memory(kind, text, reason, provenance, video_id, created_at, updated_at) VALUES(?,?,?,?,?,?,?)').run(input.kind as string, text, reason, input.provenance, videoId, t, t);
    const id = Number(r.lastInsertRowid);
    indexPut(this.db, 'memory', id, String(input.kind), reason ? `${text}\nWhy: ${reason}` : text);
    this.pushUndo(`Remembered: ${text.slice(0, 60)}`, [{ op: 'delete_memory', id }]);
    return this.memRow(this.db.prepare('SELECT * FROM memory WHERE id = ?').get(id));
  }
  updateMemory(id: number, patch: { text?: unknown; reason?: unknown; kind?: unknown }): MemoryItem {
    const cur = this.db.prepare('SELECT * FROM memory WHERE id = ?').get(id) as any;
    if (!cur) throw new Error('That memory no longer exists.');
    const text = patch.text !== undefined ? str(patch.text, 4000, 'Memory text') : cur.text;
    const reason = patch.reason !== undefined ? (patch.reason === null ? null : str(patch.reason, 2000, 'Reason', true) || null) : cur.reason;
    const kind = patch.kind !== undefined ? patch.kind : cur.kind;
    if (!MEMORY_KINDS.includes(kind as MemoryKind)) throw new Error('Unknown memory kind.');
    // An item Gavin has edited is his statement from then on.
    this.db.prepare("UPDATE memory SET text=?, reason=?, kind=?, provenance='gavin', updated_at=? WHERE id=?").run(text, reason, kind as string, nowIso(), id);
    indexPut(this.db, 'memory', id, String(kind), reason ? `${text}\nWhy: ${reason}` : text);
    return this.memRow(this.db.prepare('SELECT * FROM memory WHERE id = ?').get(id));
  }
  private rawDeleteMemory(id: number): void { this.db.prepare('DELETE FROM memory WHERE id = ?').run(id); indexDelete(this.db, 'memory', id); }
  deleteMemory(id: number): void { this.rawDeleteMemory(id); }

  // ---------- sources and scores ----------
  listSources(videoId: number | null): Source[] {
    const rows = (videoId === null ? this.db.prepare('SELECT * FROM sources ORDER BY id DESC').all() : this.db.prepare('SELECT * FROM sources WHERE video_id = ? ORDER BY id DESC').all(videoId)) as any[];
    return rows.map((r) => ({ id: r.id, videoId: r.video_id, url: r.url, title: r.title, publishedDate: r.published_date, note: r.note, provenance: r.provenance, createdAt: r.created_at }));
  }
  addSource(input: { videoId?: number | null; url: unknown; title: unknown; publishedDate?: unknown; note?: unknown; provenance: Provenance }): Source {
    const url = str(input.url, 2000, 'URL');
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error('The source URL is not valid.'); }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Sources must be http(s) links.');
    const title = str(input.title, 300, 'Source title');
    const date = input.publishedDate ? str(input.publishedDate, 30, 'Published date') : null;
    if (date && !/^\d{4}(-\d{2}(-\d{2})?)?$/.test(date)) throw new Error('Published date must look like 2026-05-01, 2026-05 or 2026.');
    const note = input.note ? str(input.note, 2000, 'Note', true) : null;
    const videoId = input.videoId ?? null;
    if (videoId !== null && !this.getVideo(videoId)) throw new Error(`There is no video with id ${videoId}.`);
    const r = this.db.prepare('INSERT INTO sources(video_id, url, title, published_date, note, provenance, created_at) VALUES(?,?,?,?,?,?,?)').run(videoId, url, title, date, note, input.provenance, nowIso());
    const id = Number(r.lastInsertRowid);
    this.pushUndo(`Saved source “${title.slice(0, 50)}”`, [{ op: 'delete_source', id }]);
    return this.listSources(null).find((s) => s.id === id)!;
  }
  deleteSource(id: number): void { this.db.prepare('DELETE FROM sources WHERE id = ?').run(id); }

  listScores(videoId: number): Score[] {
    return (this.db.prepare('SELECT * FROM scores WHERE video_id = ? ORDER BY id DESC').all(videoId) as any[]).map((r) => {
      const c = JSON.parse(r.components);
      return { id: r.id, videoId: r.video_id, createdAt: r.created_at, rulesVersion: r.rules_version, notes: r.notes, components: c.components, weakest: c.weakest, total: r.total, displayTotal: displayScore(r.total) };
    });
  }
  /** Stores a dated score. The total is always computed here from the components, never taken from the model. */
  addScore(input: { videoId: number; components: unknown; weakest: unknown; notes: unknown; rulesVersion: string }): Score {
    if (!this.getVideo(input.videoId)) throw new Error(`There is no video with id ${input.videoId}.`);
    const keys = ['clarity', 'emotion', 'depth', 'demand', 'originality'] as const;
    const c = input.components as Record<string, unknown>;
    if (!c || typeof c !== 'object') throw new Error('Score components are missing.');
    const comp: any = {};
    for (const k of keys) {
      const n = c[k];
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 20) throw new Error(`Component "${k}" must be a whole number from 0 to 20.`);
      comp[k] = n;
    }
    const total = keys.reduce((a, k) => a + comp[k], 0);
    const weakest = str(input.weakest, 600, 'Weakest part');
    const notes = str(input.notes, 4000, 'Score notes', true);
    const r = this.db.prepare('INSERT INTO scores(video_id, components, total, notes, rules_version, created_at) VALUES(?,?,?,?,?,?)')
      .run(input.videoId, JSON.stringify({ components: comp, weakest }), total, notes, input.rulesVersion, nowIso());
    const id = Number(r.lastInsertRowid);
    this.pushUndo(`Scored video ${input.videoId}: ${displayScore(total)}/100`, [{ op: 'delete_score', id }]);
    return this.listScores(input.videoId).find((s) => s.id === id)!;
  }

  // ---------- imported / folder context ----------
  listContextDocs(): ContextDoc[] {
    return (this.db.prepare('SELECT id, source, path, title, LENGTH(content) AS chars, mtime, imported_at FROM context_docs ORDER BY source, path').all() as any[])
      .map((r) => ({ id: r.id, source: r.source, path: r.path, title: r.title, chars: r.chars, mtime: r.mtime, importedAt: r.imported_at }));
  }
  upsertContextDoc(source: 'folder' | 'import', path: string, title: string, content: string, mtime: string | null): void {
    const t = nowIso();
    this.db.prepare(`INSERT INTO context_docs(source, path, title, content, mtime, imported_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(source, path) DO UPDATE SET title = excluded.title, content = excluded.content, mtime = excluded.mtime, imported_at = excluded.imported_at`)
      .run(source, path, title, content, mtime, t);
    const id = (this.db.prepare('SELECT id FROM context_docs WHERE source = ? AND path = ?').get(source, path) as { id: number }).id;
    indexPut(this.db, `context_${source}`, id, title, content);
  }
  removeContextDoc(id: number): void {
    const r = this.db.prepare('SELECT source FROM context_docs WHERE id = ?').get(id) as { source: string } | undefined;
    if (!r) return;
    this.db.prepare('DELETE FROM context_docs WHERE id = ?').run(id);
    indexDelete(this.db, `context_${r.source}`, id);
  }
  getContextDoc(id: number): { title: string; path: string; content: string; source: string; importedAt: string } | null {
    const r = this.db.prepare('SELECT * FROM context_docs WHERE id = ?').get(id) as any;
    return r ? { title: r.title, path: r.path, content: r.content, source: r.source, importedAt: r.imported_at } : null;
  }

  // ---------- search ----------
  /** Full-text search over videos, documents, memory and Gubbo context. Returns short snippets, never whole files. */
  search(query: string, limit = 8): SearchHit[] {
    const terms = ftsTerms(query);
    if (!terms.length) return [];
    const match = terms.map((t) => `"${t}"`).join(' OR ');
    let rows: any[];
    try {
      rows = this.db.prepare(`SELECT kind, ref_id, title, snippet(search_index, 3, '', '', ' … ', 48) AS snip FROM search_index WHERE search_index MATCH ? ORDER BY bm25(search_index, 0, 0, 4, 1) LIMIT ?`).all(match, limit) as any[];
    } catch { return []; }
    return rows.map((r) => ({ kind: r.kind, refId: Number(r.ref_id), title: r.title, snippet: r.snip, provenance: this.provenanceOf(r.kind, Number(r.ref_id)) }));
  }
  private provenanceOf(kind: string, id: number): Provenance {
    if (kind === 'context_import') return 'gubbo_import';
    if (kind === 'context_folder') return 'gubbo_folder';
    if (kind === 'memory') return ((this.db.prepare('SELECT provenance FROM memory WHERE id = ?').get(id) as any)?.provenance ?? 'assistant') as Provenance;
    if (kind === 'document') {
      const a = (this.db.prepare('SELECT v.author FROM documents d JOIN doc_versions v ON v.document_id = d.id AND v.version = d.current_version WHERE d.id = ?').get(id) as any)?.author;
      return a === 'gavin' ? 'gavin' : 'assistant';
    }
    return 'gavin';
  }

  /** "What was I working on last time?" — answered from local data. */
  recentActivity(): { videos: Video[]; nextActions: MemoryItem[]; lastDocs: DocSummary[] } {
    const videos = this.listVideos().slice(0, 5);
    const nextActions = this.listMemory({ kind: 'next_action' }).slice(0, 5);
    const lastDocs = (this.db.prepare(`SELECT d.*, '' AS author FROM documents d ORDER BY updated_at DESC LIMIT 5`).all() as any[]).map(this.docRow);
    return { videos, nextActions, lastDocs };
  }
}

const STOP = new Set('a an and are as at be but by for from has have how i if in into is it its me my of on or our so that the their them then there these they this to was we were what when where which who why will with you your about can could do does did just not'.split(' '));

export function ftsTerms(query: string): string[] {
  const words = query.toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  return [...new Set(words.filter((w) => !STOP.has(w)))].slice(0, 24);
}
