import { DatabaseSync } from 'node:sqlite';

export type DB = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, mode TEXT NOT NULL, system_prompt TEXT NOT NULL,
  video_id INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL,
  api_content TEXT, model TEXT, meta TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS messages_conv ON messages(conversation_id, id);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, model TEXT NOT NULL, purpose TEXT NOT NULL,
  reserved_usd REAL NOT NULL, actual_usd REAL, status TEXT NOT NULL, usage TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS memory (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, reason TEXT, provenance TEXT NOT NULL,
  video_id INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, premise TEXT NOT NULL DEFAULT '', format TEXT NOT NULL DEFAULT 'long',
  stage TEXT NOT NULL DEFAULT 'Idea', published_video_id TEXT, asset_links TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY, video_id INTEGER, kind TEXT NOT NULL, title TEXT NOT NULL,
  current_version INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS doc_versions (
  id INTEGER PRIMARY KEY, document_id INTEGER NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL,
  author TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY, video_id INTEGER, url TEXT NOT NULL, title TEXT NOT NULL, published_date TEXT,
  note TEXT, provenance TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY, video_id INTEGER NOT NULL, components TEXT NOT NULL, total INTEGER NOT NULL,
  notes TEXT NOT NULL, rules_version TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS context_docs (
  id INTEGER PRIMARY KEY, source TEXT NOT NULL, path TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
  mtime TEXT, imported_at TEXT NOT NULL, UNIQUE(source, path));
CREATE TABLE IF NOT EXISTS undo_log (
  id INTEGER PRIMARY KEY, label TEXT NOT NULL, ops TEXT NOT NULL, created_at TEXT NOT NULL, undone INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS yt_cache (key TEXT PRIMARY KEY, fetched_at TEXT NOT NULL, payload TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(kind UNINDEXED, ref_id UNINDEXED, title, body, tokenize='porter unicode61');
`;

export function openDb(file: string): DB {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export const nowIso = () => new Date().toISOString();

/** Run fn inside an immediate transaction; the synchronous API means no other statement can interleave. */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function getSetting<T>(db: DB, key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try { return JSON.parse(row.value) as T; } catch { return fallback; }
}

export function setSetting(db: DB, key: string, value: unknown): void {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

export function indexPut(db: DB, kind: string, refId: number, title: string, body: string): void {
  db.prepare('DELETE FROM search_index WHERE kind = ? AND ref_id = ?').run(kind, refId);
  db.prepare('INSERT INTO search_index(kind, ref_id, title, body) VALUES(?, ?, ?, ?)').run(kind, refId, title, body);
}

export function indexDelete(db: DB, kind: string, refId: number): void {
  db.prepare('DELETE FROM search_index WHERE kind = ? AND ref_id = ?').run(kind, refId);
}
