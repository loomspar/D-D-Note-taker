import { useEffect, useState } from 'react';
import { MEMORY_KINDS } from '../../shared/types';
import type { MemoryItem, SearchHit } from '../../shared/types';
import { call } from '../bridge';
import { useApp } from './app';

const KIND: Record<string, string> = { preference: 'Preferences', accepted: 'Accepted decisions', rejected: 'Rejected ideas (and why)', lesson: 'Tentative lessons', next_action: 'Next actions', fact: 'Facts' };
const PROV: Record<string, string> = { gavin: 'You said this', assistant: 'Gubbo’s suggestion', gubbo_import: 'Imported Gubbo document', gubbo_folder: 'Gubbo folder file', analytics: 'Channel analytics', research: 'Outside research' };

export function MemoryScreen() {
  const { toast } = useApp();
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [edit, setEdit] = useState<{ id: number | null; kind: string; text: string; reason: string } | null>(null);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const load = async () => setItems(await call('memory:list'));
  useEffect(() => { void load(); }, []);
  const save = async () => {
    if (!edit) return;
    try {
      if (edit.id === null) await call('memory:add', { kind: edit.kind, text: edit.text, reason: edit.reason || null });
      else await call('memory:update', { id: edit.id, kind: edit.kind, text: edit.text, reason: edit.reason || null });
      setEdit(null); await load();
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <div className="scroll pad">
      <div className="inline spread"><h2>What Gubbo remembers</h2><button className="primary" onClick={() => setEdit({ id: null, kind: 'preference', text: '', reason: '' })}>+ Add a memory</button></div>
      <p className="muted">Everything here is stored on this PC. You can change or delete any of it; Gubbo cannot delete memories itself. Each item shows whether you said it or Gubbo inferred it.</p>
      <form className="inline" onSubmit={async (e) => { e.preventDefault(); setHits(q.trim() ? await call('search', q) : null); }}>
        <input className="grow" placeholder="Search videos, documents, memory and Gubbo context…" value={q} onChange={(e) => setQ(e.target.value)} /><button>Search</button>{hits && <button type="button" onClick={() => { setHits(null); setQ(''); }}>Clear</button>}
      </form>
      {hits && <div className="card"><h4>{hits.length} result(s)</h4><ul className="list">{hits.map((h, i) => <li key={i}><b>{h.title}</b> <span className="pill">{PROV[h.provenance] ?? h.provenance}</span><p className="muted">{h.snippet}</p></li>)}</ul></div>}
      {edit && (
        <div className="card">
          <div className="inline wrap"><select value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })}>{MEMORY_KINDS.map((k) => <option key={k} value={k}>{KIND[k]}</option>)}</select></div>
          <textarea rows={3} placeholder="What should Gubbo remember?" value={edit.text} onChange={(e) => setEdit({ ...edit, text: e.target.value })} />
          <input placeholder="Why (optional; needed for rejected ideas)" value={edit.reason} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} />
          <div className="inline"><button className="primary" disabled={!edit.text.trim()} onClick={save}>Save</button><button onClick={() => setEdit(null)}>Cancel</button></div>
        </div>
      )}
      {MEMORY_KINDS.map((k) => {
        const list = items.filter((m) => m.kind === k);
        return list.length ? (
          <section key={k}><h3>{KIND[k]}</h3>
            <ul className="list">{list.map((m) => (
              <li key={m.id}>{m.text}{m.reason && <span className="muted"> — why: {m.reason}</span>}
                <div className="meta"><span className={`pill ${m.provenance === 'gavin' ? 'ok' : ''}`}>{PROV[m.provenance]}</span><span className="muted">{new Date(m.updatedAt).toLocaleDateString()}{m.videoId ? ` · video #${m.videoId}` : ''}</span>
                  <button className="link" onClick={() => setEdit({ id: m.id, kind: m.kind, text: m.text, reason: m.reason ?? '' })}>Edit</button>
                  <button className="link danger" onClick={async () => { await call('memory:delete', m.id); await load(); }}>Delete</button></div>
              </li>))}</ul>
          </section>) : null;
      })}
      {items.length === 0 && <p className="muted">Nothing saved yet. Tell Gubbo “remember that…” or add something here.</p>}
    </div>
  );
}
