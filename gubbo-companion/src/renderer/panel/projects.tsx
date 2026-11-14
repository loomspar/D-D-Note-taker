import { useEffect, useState } from 'react';
import { DOC_KINDS, STAGES } from '../../shared/types';
import type { BrainDumpItem, DocSummary, DocVersion, MemoryItem, Score, Source, UndoEntry, Video } from '../../shared/types';
import { call } from '../bridge';
import { useApp } from './app';
import { Markdown } from './md';

interface Detail { video: Video; documents: DocSummary[]; scores: Score[]; sources: Source[]; memory: MemoryItem[] }
const kindLabel = (k: string) => k.replace(/_/g, ' ');

function DocEditor({ id, onClose }: { id: number; onClose: () => void }) {
  const { toast, readAloud } = useApp();
  const [d, setD] = useState<{ doc: DocSummary; content: string; versions: DocVersion[] } | null>(null);
  const [text, setText] = useState('');
  const [edit, setEdit] = useState(false);
  const load = async () => { const x = await call('doc:get', id); setD(x); setText(x?.content ?? ''); };
  useEffect(() => { void load(); }, [id]);
  if (!d) return null;
  return (
    <div className="doc">
      <div className="inline spread">
        <h3>{d.doc.title} <span className="muted">{kindLabel(d.doc.kind)} · v{d.doc.version} · by {d.doc.author === 'gavin' ? 'you' : 'Gubbo'}</span></h3>
        <div className="inline">
          <button onClick={() => readAloud(d.content)}>Read aloud</button>
          {edit ? <><button className="primary" disabled={text === d.content} onClick={async () => { await call('doc:save', { documentId: id, content: text }); setEdit(false); await load(); toast('Saved as a new version.', 'ok'); }}>Save new version</button><button onClick={() => { setText(d.content); setEdit(false); }}>Cancel</button></> : <button onClick={() => setEdit(true)}>Edit</button>}
          <button onClick={onClose}>Close</button>
        </div>
      </div>
      {edit ? <textarea className="editor" value={text} onChange={(e) => setText(e.target.value)} /> : <Markdown text={d.content || '_Empty._'} />}
      {d.versions.length > 1 && (
        <details><summary>Version history ({d.versions.length})</summary>
          <ul className="list">{d.versions.map((v) => <li key={v.id}>v{v.version} · {new Date(v.createdAt).toLocaleString()} · {v.author === 'gavin' ? 'you' : 'Gubbo'} {v.version === d.doc.version ? <span className="pill ok">current</span> : <button onClick={async () => { setD(await call('doc:revert', { id, version: v.version })); await load(); }}>Make current</button>}</li>)}</ul>
        </details>
      )}
      <button className="link danger" onClick={async () => { if (confirm('Delete this document and all its versions?')) { await call('doc:delete', id); onClose(); } }}>Delete document</button>
    </div>
  );
}

function BrainDump({ videoId, onDone }: { videoId: number | null; onDone: () => void }) {
  const { voiceToggle, captureTranscript, phase, toast, celebrate, refreshStatus } = useApp();
  const [text, setText] = useState('');
  const [items, setItems] = useState<BrainDumpItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { captureTranscript((t) => setText((p) => (p ? `${p}\n${t}` : t))); return () => captureTranscript(null); }, []);
  const preview = async () => {
    setBusy(true);
    try { const r = await call('braindump:preview', text); if (r.ok) setItems(r.items); else toast(r.message, 'warn'); await refreshStatus(); }
    catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const apply = async (list: BrainDumpItem[]) => {
    const r = await call('braindump:apply', { transcript: text, items: list, videoId });
    toast(`Saved the transcript and ${r.saved} item(s). Undo is in History.`, 'ok'); celebrate(); onDone();
  };
  return (
    <div className="card">
      <h3>Brain dump</h3>
      <p className="muted">Talk or type freely. Your exact words are always kept as a voice note. Gubbo can then sort out ideas and tasks and show you where each would be saved before anything is filed.</p>
      <textarea rows={7} value={text} onChange={(e) => setText(e.target.value)} placeholder="Everything on your mind…" />
      <div className="inline wrap">
        <button onClick={voiceToggle} disabled={phase === 'transcribing' || phase === 'thinking'}>{phase === 'listening' ? '■ Stop and add' : '🎙 Record'}</button>
        <button className="primary" disabled={!text.trim() || busy} onClick={preview} title="Uses a small amount of Claude credit">{busy ? 'Sorting…' : 'Sort it out (uses Claude credit)'}</button>
        <button disabled={!text.trim()} onClick={() => apply([])}>Just save the transcript</button>
        <button onClick={onDone}>Cancel</button>
      </div>
      {items && (
        <>
          <h4>Preview — untick anything you don’t want saved</h4>
          {items.length === 0 && <p className="muted">Nothing separate was found; the transcript will be saved as a note.</p>}
          <ul className="list">{items.map((it, i) => (
            <li key={i}><label className="check"><input type="checkbox" defaultChecked onChange={(e) => { (it as any).skip = !e.target.checked; }} /> <b>{it.title}</b> <span className="pill">{it.type}</span> → <i>{it.target}</i></label><p className="muted">{it.text}</p></li>))}</ul>
          <button className="primary" onClick={() => apply(items.filter((x) => !(x as any).skip))}>Save these</button>
        </>
      )}
    </div>
  );
}

export function ProjectsScreen() {
  const { toast, chat, setTab, celebrate } = useApp();
  const [videos, setVideos] = useState<Video[]>([]);
  const [sel, setSel] = useState<number | null>(null);
  const [d, setD] = useState<Detail | null>(null);
  const [docId, setDocId] = useState<number | null>(null);
  const [dump, setDump] = useState(false);
  const [history, setHistory] = useState<UndoEntry[] | null>(null);
  const [newDoc, setNewDoc] = useState<{ kind: string; title: string } | null>(null);
  const [src, setSrc] = useState<{ url: string; title: string; publishedDate: string } | null>(null);
  const [decision, setDecision] = useState<{ kind: string; text: string; reason: string } | null>(null);
  const load = async () => setVideos(await call('videos:list'));
  const loadDetail = async (id: number | null) => { setSel(id); setDocId(null); setD(id === null ? null : await call('video:get', id).catch(() => null)); };
  useEffect(() => { void load(); }, []);
  const guard = async (fn: () => Promise<unknown>) => { try { await fn(); await load(); if (sel !== null) setD(await call('video:get', sel).catch(() => null)); } catch (e) { toast((e as Error).message, 'error'); } };
  const ask = (text: string, deep = false) => { setTab('chat'); chat.send(text, { newConversation: true, videoId: sel, mode: deep ? 'deep' : 'conversation' }); };
  const v = d?.video;

  return (
    <div className="projects">
      <aside>
        <div className="inline wrap">
          <button className="primary" onClick={() => guard(async () => { const nv = await call<Video>('video:create', { title: 'Untitled idea', format: 'long' }); await loadDetail(nv.id); })}>+ New video</button>
          <button onClick={() => { setDump(true); setDocId(null); }}>Brain dump</button>
          <button onClick={async () => setHistory(history ? null : await call('undo:list'))}>History</button>
        </div>
        {STAGES.map((stage) => {
          const list = videos.filter((x) => x.stage === stage);
          return list.length ? <div key={stage}><h5>{stage} <span className="muted">{list.length}</span></h5><ul>{list.map((x) => <li key={x.id} className={x.id === sel ? 'sel' : ''} onClick={() => { setDump(false); void loadDetail(x.id); }}>{x.title}{x.format === 'short' && <i className="tag">Short</i>}</li>)}</ul></div> : null;
        })}
        {videos.length === 0 && <p className="muted">No videos yet. Save an idea from a conversation, start one here, or do a brain dump.</p>}
      </aside>
      <div className="scroll pad">
        {history && (
          <div className="card"><h3>History — recent changes</h3>
            <ul className="list">{history.map((h) => <li key={h.id}>{new Date(h.createdAt).toLocaleString()} · {h.label} {h.undone ? <span className="pill">undone</span> : <button onClick={() => guard(async () => { await call('undo:do', h.id); setHistory(await call('undo:list')); toast('Undone.', 'ok'); })}>Undo</button>}</li>)}</ul>
            {history.length === 0 && <p className="muted">Nothing yet.</p>}
          </div>)}
        {dump && <BrainDump videoId={sel} onDone={() => { setDump(false); void guard(async () => {}); }} />}
        {!dump && docId !== null && <DocEditor id={docId} onClose={() => { setDocId(null); void guard(async () => {}); }} />}
        {!dump && docId === null && v && d && (
          <>
            <input className="title" value={v.title} onChange={(e) => setD({ ...d, video: { ...v, title: e.target.value } })} onBlur={(e) => guard(() => call('video:update', { id: v.id, patch: { title: e.target.value } }))} />
            <div className="inline wrap">
              <select value={v.stage} onChange={(e) => guard(async () => { await call('video:update', { id: v.id, patch: { stage: e.target.value } }); if (e.target.value === 'Published') celebrate(); })}>{STAGES.map((s) => <option key={s}>{s}</option>)}</select>
              <select value={v.format} onChange={(e) => guard(() => call('video:update', { id: v.id, patch: { format: e.target.value } }))}><option value="long">Long-form</option><option value="short">Short</option></select>
              <input placeholder="Published video ID (optional)" defaultValue={v.publishedVideoId ?? ''} onBlur={(e) => { if ((e.target.value || null) !== v.publishedVideoId) void guard(() => call('video:update', { id: v.id, patch: { publishedVideoId: e.target.value.trim() || null } })); }} />
            </div>
            <label className="stack">Premise<textarea rows={3} value={v.premise} onChange={(e) => setD({ ...d, video: { ...v, premise: e.target.value } })} onBlur={(e) => guard(() => call('video:update', { id: v.id, patch: { premise: e.target.value } }))} /></label>
            <div className="inline wrap">
              <button onClick={() => ask(`Let's develop my video “${v.title}” (video id ${v.id}). Read what's saved for it first, then tell me candidly what's weakest and what to do next.`, true)}>Brainstorm this with Gubbo</button>
              <button onClick={() => ask(`Score my video “${v.title}” (video id ${v.id}) using my Gubbo rules, save the score, and tell me the weakest part.`)}>Score it</button>
              <button onClick={() => ask(`Turn my video “${v.title}” (video id ${v.id}) into a recording checklist and save it to the video.`)}>Make a recording checklist</button>
              {v.publishedVideoId && <button onClick={() => { setTab('chat'); chat.send(`Review how my published video “${v.title}” (YouTube id ${v.publishedVideoId}, video id ${v.id}) is doing against my other recent videos, and save tentative lessons — clearly marked as tentative.`, { newConversation: true, videoId: v.id, includeAnalytics: true }); }}>Review results</button>}
            </div>

            <h4>Score</h4>
            {d.scores.length ? d.scores.slice(0, 3).map((s) => (
              <div key={s.id} className="card score"><b className="total">{s.displayTotal}<small>/100</small></b>
                <div><div className="bars">{(['clarity', 'emotion', 'depth', 'demand', 'originality'] as const).map((k) => <span key={k} title={`${k}: ${s.components[k]}/20`}><i style={{ height: `${s.components[k] * 5}%` }} />{k.slice(0, 5)} {s.components[k]}</span>)}</div>
                  <p><b>Weakest:</b> {s.weakest}</p>{s.notes && <p className="muted">{s.notes}</p>}<p className="muted">{new Date(s.createdAt).toLocaleDateString()} · rules {s.rulesVersion} · editorial judgment, not a probability</p></div></div>
            )) : <p className="muted">Not scored yet.</p>}

            <div className="inline spread"><h4>Documents</h4><button onClick={() => setNewDoc({ kind: 'outline', title: '' })}>+ Add</button></div>
            {newDoc && <div className="inline wrap"><select value={newDoc.kind} onChange={(e) => setNewDoc({ ...newDoc, kind: e.target.value })}>{DOC_KINDS.map((k) => <option key={k} value={k}>{kindLabel(k)}</option>)}</select><input className="grow" placeholder="Title" value={newDoc.title} onChange={(e) => setNewDoc({ ...newDoc, title: e.target.value })} /><button className="primary" disabled={!newDoc.title.trim()} onClick={() => guard(async () => { const nd = await call<DocSummary>('doc:save', { videoId: v.id, kind: newDoc.kind, title: newDoc.title, content: '' }); setNewDoc(null); setDocId(nd.id); })}>Create</button><button onClick={() => setNewDoc(null)}>Cancel</button></div>}
            <ul className="list">{d.documents.map((x) => <li key={x.id} className="click" onClick={() => setDocId(x.id)}><b>{x.title}</b> <span className="muted">{kindLabel(x.kind)} · v{x.version} · {x.author === 'gavin' ? 'you' : 'Gubbo'} · {new Date(x.updatedAt).toLocaleDateString()}</span></li>)}</ul>
            {d.documents.length === 0 && <p className="muted">Outlines, scripts, checklists, title options and notes will appear here.</p>}

            <div className="inline spread"><h4>Decisions and lessons</h4><button onClick={() => setDecision({ kind: 'accepted', text: '', reason: '' })}>+ Add</button></div>
            {decision && <div className="inline wrap"><select value={decision.kind} onChange={(e) => setDecision({ ...decision, kind: e.target.value })}><option value="accepted">Accepted</option><option value="rejected">Rejected</option><option value="lesson">Tentative lesson</option><option value="next_action">Next action</option></select><input className="grow" placeholder="What" value={decision.text} onChange={(e) => setDecision({ ...decision, text: e.target.value })} /><input className="grow" placeholder="Why (required for rejected)" value={decision.reason} onChange={(e) => setDecision({ ...decision, reason: e.target.value })} /><button className="primary" disabled={!decision.text.trim() || (decision.kind === 'rejected' && !decision.reason.trim())} onClick={() => guard(async () => { await call('memory:add', { ...decision, reason: decision.reason || null, videoId: v.id }); setDecision(null); })}>Save</button><button onClick={() => setDecision(null)}>Cancel</button></div>}
            <ul className="list">{d.memory.map((m) => <li key={m.id}><span className={`pill ${m.kind === 'rejected' ? 'bad' : m.kind === 'accepted' ? 'ok' : ''}`}>{m.kind === 'lesson' ? 'tentative lesson' : kindLabel(m.kind)}</span> {m.text}{m.reason && <span className="muted"> — {m.reason}</span>} <span className="muted">({m.provenance === 'gavin' ? 'you' : 'Gubbo’s suggestion'})</span></li>)}</ul>

            <div className="inline spread"><h4>Research sources</h4><button onClick={() => setSrc({ url: '', title: '', publishedDate: '' })}>+ Add link</button></div>
            {src && <div className="inline wrap"><input className="grow" placeholder="https://…" value={src.url} onChange={(e) => setSrc({ ...src, url: e.target.value })} /><input className="grow" placeholder="Title" value={src.title} onChange={(e) => setSrc({ ...src, title: e.target.value })} /><input placeholder="Published (YYYY-MM-DD)" value={src.publishedDate} onChange={(e) => setSrc({ ...src, publishedDate: e.target.value })} /><button className="primary" disabled={!src.url || !src.title} onClick={() => guard(async () => { await call('source:add', { ...src, videoId: v.id }); setSrc(null); })}>Save</button><button onClick={() => setSrc(null)}>Cancel</button></div>}
            <ul className="list">{d.sources.map((s) => <li key={s.id}><a href={s.url} onClick={(e) => { e.preventDefault(); void call('external:open', s.url); }}>{s.title}</a> <span className="muted">{s.publishedDate ? `published ${s.publishedDate}` : 'publish date unknown'} · {s.provenance === 'gavin' ? 'added by you' : 'found by Gubbo’s research'}{s.note ? ` · ${s.note}` : ''}</span> <button className="x" onClick={() => guard(() => call('source:delete', s.id))}>×</button></li>)}</ul>

            <button className="link danger" onClick={() => guard(async () => { if (await call('video:delete', v.id)) await loadDetail(null); })}>Delete this video…</button>
          </>
        )}
        {!dump && docId === null && !v && !history && <div className="empty"><h2>Your videos</h2><p className="muted">Each video moves through: {STAGES.join(' → ')}.</p></div>}
      </div>
    </div>
  );
}
