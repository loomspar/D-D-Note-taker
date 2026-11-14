// The only actions the model can take. Each tool is narrow, validates its input, and can create or
// version things but never delete. There is no shell, no arbitrary file path, and no network tool here.
import type Anthropic from '@anthropic-ai/sdk';
import { DOC_KINDS, MEMORY_KINDS, STAGES } from '../shared/types';
import type { ChannelReport, Settings } from '../shared/types';
import type { Store } from './store';

export interface ToolDeps {
  store: Store;
  settings: () => Settings;
  channelReport: () => { report: ChannelReport | null; stale: boolean; connected: boolean };
  /** Mirrors an assistant-written document into the Gubbo folder's notes subfolder, when one is connected. */
  mirrorNote?: (title: string, content: string) => string | null;
}

const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object' as const, properties, required, additionalProperties: false });
const idProp = { type: 'integer', description: 'Numeric id from list_videos / get_video.' };

export const TOOL_DEFS: Anthropic.Tool[] = [
  { name: 'search_notes', description: 'Full-text search across Gavin\'s saved videos, documents, memory, and imported Gubbo context. Returns short labelled snippets. Use it before claiming something was or was not saved.', input_schema: obj({ query: { type: 'string' } }, ['query']) },
  { name: 'recent_activity', description: 'What Gavin worked on most recently: latest videos, documents and open next actions.', input_schema: obj({}, []) },
  { name: 'list_videos', description: 'List every saved video project with id, title, stage and format.', input_schema: obj({}, []) },
  { name: 'get_video', description: 'One video project in full: premise, documents, latest score, decisions and sources.', input_schema: obj({ video_id: idProp }, ['video_id']) },
  { name: 'read_document', description: 'Read the current version of a saved document.', input_schema: obj({ document_id: { type: 'integer' } }, ['document_id']) },
  { name: 'save_video_idea', description: 'Save a new video project card. Only when Gavin asks to save or keep an idea.', input_schema: obj({ title: { type: 'string' }, premise: { type: 'string' }, format: { type: 'string', enum: ['long', 'short'] }, stage: { type: 'string', enum: [...STAGES] } }, ['title', 'premise', 'format']) },
  { name: 'update_video', description: 'Change a video\'s title, premise, format or stage.', input_schema: obj({ video_id: idProp, title: { type: 'string' }, premise: { type: 'string' }, format: { type: 'string', enum: ['long', 'short'] }, stage: { type: 'string', enum: [...STAGES] } }, ['video_id']) },
  { name: 'save_document', description: 'Save a document (outline, script, recording checklist, shot list, title options, …) to a video, or add a new version of an existing document by passing document_id. Earlier versions are kept.', input_schema: obj({ video_id: idProp, document_id: { type: 'integer' }, kind: { type: 'string', enum: [...DOC_KINDS] }, title: { type: 'string' }, content: { type: 'string', description: 'Full Markdown content.' } }, ['kind', 'title', 'content']) },
  { name: 'remember', description: 'Store a durable memory: a preference Gavin stated, an accepted decision, a rejected idea with the reason, a tentative lesson, or the next useful action.', input_schema: obj({ kind: { type: 'string', enum: [...MEMORY_KINDS] }, text: { type: 'string' }, reason: { type: 'string', description: 'Why — required for rejected ideas.' }, video_id: idProp, stated_by_gavin: { type: 'boolean', description: 'True only if Gavin said this himself; false if it is your own suggestion or inference.' } }, ['kind', 'text', 'stated_by_gavin']) },
  { name: 'save_score', description: 'Record a dated Gubbo Virality Score for a saved video. Give the five component scores (0–20 each); the app adds the total.', input_schema: obj({ video_id: idProp, clarity: { type: 'integer' }, emotion: { type: 'integer' }, depth: { type: 'integer' }, demand: { type: 'integer' }, originality: { type: 'integer' }, weakest: { type: 'string', description: 'The weakest part of the concept, candidly.' }, notes: { type: 'string' } }, ['video_id', 'clarity', 'emotion', 'depth', 'demand', 'originality', 'weakest', 'notes']) },
  { name: 'save_source', description: 'Save a research source that you actually retrieved this conversation or that Gavin supplied. Never save a URL you have not seen.', input_schema: obj({ video_id: idProp, url: { type: 'string' }, title: { type: 'string' }, published_date: { type: 'string', description: 'YYYY-MM-DD, YYYY-MM or YYYY if known.' }, note: { type: 'string' }, supplied_by_gavin: { type: 'boolean' } }, ['url', 'title', 'supplied_by_gavin']) },
  { name: 'get_channel_analytics', description: 'Gavin\'s own YouTube channel figures as last fetched by the app (read-only): subscribers (rounded by YouTube), 7- and 28-day totals with comparisons, top videos and recent uploads. Includes fetch time and data cutoff.', input_schema: obj({}, []) },
].map((t) => ({ ...t, eager_input_streaming: true }));

export const TOOL_NAMES = new Set(TOOL_DEFS.map((t) => t.name));

class InputError extends Error {}

/** Checks the parsed input against the tool's schema: required keys, no extras, primitive types, enums. */
export function validateInput(name: string, input: unknown): Record<string, any> {
  const def = TOOL_DEFS.find((t) => t.name === name);
  if (!def) throw new InputError(`Unknown tool "${name}".`);
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new InputError('Tool input must be a JSON object.');
  const schema = def.input_schema as { properties: Record<string, { type: string; enum?: string[] }>; required: string[] };
  const rec = input as Record<string, unknown>;
  for (const k of Object.keys(rec)) if (!(k in schema.properties)) throw new InputError(`Unexpected field "${k}".`);
  for (const k of schema.required) if (rec[k] === undefined || rec[k] === null) throw new InputError(`Missing required field "${k}".`);
  for (const [k, v] of Object.entries(rec)) {
    if (v === undefined || v === null) { delete rec[k]; continue; }
    const p = schema.properties[k];
    const ok = p.type === 'integer' ? Number.isSafeInteger(v) : p.type === 'boolean' ? typeof v === 'boolean' : typeof v === 'string';
    if (!ok) throw new InputError(`Field "${k}" must be ${p.type === 'integer' ? 'a whole number' : p.type === 'boolean' ? 'true or false' : 'text'}.`);
    if (p.enum && !p.enum.includes(v as string)) throw new InputError(`Field "${k}" must be one of: ${p.enum.join(', ')}.`);
  }
  return rec;
}

export interface ToolOutcome { content: string; isError: boolean; note: string | null }

/** Runs one tool call. Errors are returned to the model as tool errors, never thrown into the chat loop. */
export function runTool(deps: ToolDeps, name: string, rawInput: unknown): ToolOutcome {
  const { store } = deps;
  const ok = (data: unknown, note: string | null = null): ToolOutcome => ({ content: JSON.stringify(data), isError: false, note });
  try {
    const a = validateInput(name, rawInput);
    switch (name) {
      case 'search_notes': return ok({ results: store.search(a.query, 8).map((h) => ({ kind: h.kind, id: h.refId, title: h.title, source: h.provenance, snippet: h.snippet })) });
      case 'recent_activity': {
        const r = store.recentActivity();
        return ok({ videos: r.videos.map((v) => ({ id: v.id, title: v.title, stage: v.stage, updated: v.updatedAt })), documents: r.lastDocs.map((d) => ({ id: d.id, video_id: d.videoId, kind: d.kind, title: d.title, updated: d.updatedAt })), next_actions: r.nextActions.map((m) => m.text) });
      }
      case 'list_videos': return ok({ videos: store.listVideos().map((v) => ({ id: v.id, title: v.title, stage: v.stage, format: v.format, updated: v.updatedAt })) });
      case 'get_video': {
        const v = store.getVideo(a.video_id);
        if (!v) throw new InputError(`There is no video with id ${a.video_id}.`);
        return ok({
          video: v,
          documents: store.listDocuments(v.id).map((d) => ({ id: d.id, kind: d.kind, title: d.title, version: d.version })),
          latest_score: store.listScores(v.id)[0] ?? null,
          decisions: store.listMemory({ videoId: v.id }).map((m) => ({ kind: m.kind, text: m.text, reason: m.reason, source: m.provenance })),
          sources: store.listSources(v.id).map((s) => ({ url: s.url, title: s.title, published: s.publishedDate, source: s.provenance })),
        });
      }
      case 'read_document': {
        const d = store.getDocument(a.document_id);
        if (!d) throw new InputError(`There is no document with id ${a.document_id}.`);
        return ok({ id: d.doc.id, title: d.doc.title, kind: d.doc.kind, version: d.doc.version, content: d.content });
      }
      case 'save_video_idea': { const v = store.createVideo({ title: a.title, premise: a.premise, format: a.format, stage: a.stage }); return ok({ saved: true, video_id: v.id }, `Saved idea “${v.title}”`); }
      case 'update_video': { const v = store.updateVideo(a.video_id, { title: a.title, premise: a.premise, format: a.format, stage: a.stage }); return ok({ updated: true, video: v }, `Updated “${v.title}”`); }
      case 'save_document': {
        const d = store.saveDocument({ documentId: a.document_id ?? null, videoId: a.video_id ?? null, kind: a.kind, title: a.title, content: a.content, author: 'assistant' });
        let file: string | null = null;
        try { file = deps.mirrorNote?.(d.title, a.content) ?? null; } catch { file = null; }
        return ok({ saved: true, document_id: d.id, version: d.version, also_written_to_gubbo_folder: !!file }, `Saved ${d.kind.replace(/_/g, ' ')} “${d.title}” (v${d.version})`);
      }
      case 'remember': {
        if (a.kind === 'rejected' && !a.reason) throw new InputError('A rejected idea needs the reason it was rejected.');
        const m = store.addMemory({ kind: a.kind, text: a.text, reason: a.reason, videoId: a.video_id ?? null, provenance: a.stated_by_gavin ? 'gavin' : 'assistant' });
        return ok({ remembered: true, memory_id: m.id }, `Remembered (${m.kind.replace('_', ' ')}): ${m.text.slice(0, 70)}`);
      }
      case 'save_score': {
        const s = store.addScore({ videoId: a.video_id, components: { clarity: a.clarity, emotion: a.emotion, depth: a.depth, demand: a.demand, originality: a.originality }, weakest: a.weakest, notes: a.notes, rulesVersion: deps.settings().rules.version });
        return ok({ saved: true, total_out_of_100: s.displayTotal, components: s.components }, `Scored ${s.displayTotal}/100`);
      }
      case 'save_source': {
        const s = store.addSource({ videoId: a.video_id ?? null, url: a.url, title: a.title, publishedDate: a.published_date, note: a.note, provenance: a.supplied_by_gavin ? 'gavin' : 'research' });
        return ok({ saved: true, source_id: s.id }, `Saved source “${s.title.slice(0, 50)}”`);
      }
      case 'get_channel_analytics': {
        const c = deps.channelReport();
        if (!c.connected) return ok({ available: false, reason: 'YouTube is not connected in this app. Do not guess any channel figures.' });
        if (!c.report) return ok({ available: false, reason: 'No analytics have been fetched yet. Do not guess any channel figures.' });
        return ok({ available: true, cached_and_possibly_stale: c.stale, note: 'Subscriber total is rounded down by YouTube to three significant figures. Days after latestDataDate are not processed yet and are not zeros. subsGainedFromVideo is video-attributed and does not sum to the channel-wide net change.', report: c.report });
      }
    }
    throw new InputError(`Unknown tool "${name}".`);
  } catch (e) {
    return { content: (e as Error).message || 'The tool failed.', isError: true, note: null };
  }
}
