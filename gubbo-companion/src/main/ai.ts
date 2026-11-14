// Conversation engine: streaming, cancellation, tool loop, budget reservations, persistence.
import Anthropic from '@anthropic-ai/sdk';
import type { BrainDumpItem, ChatEvent, ChatMessage, ChatMode, ChannelReport, Conversation, ModelInfo, Settings } from '../shared/types';
import type { Budget } from './budget';
import { type DB, nowIso, tx } from './db';
import { MODELS, costFromUsage, estimateTokens, maxCost } from './pricing';
import { buildContextBlock, buildSystemPrompt } from './prompt';
import { shortSpoken } from './speechText';
import type { Store } from './store';
import { TOOL_DEFS, TOOL_NAMES, type ToolDeps, runTool } from './tools';

const MAX_ITERATIONS = 6;
const MAX_TOKENS: Record<ChatMode, number> = { conversation: 8000, deep: 20000 };

export interface EngineDeps {
  db: DB; store: Store; budget: Budget;
  settings: () => Settings;
  /** Returns a client holding the stored key, or null when no key is saved. The key never leaves main. */
  client: () => Anthropic | null;
  tools: ToolDeps;
  emit: (ev: ChatEvent) => void;
}

interface Row { id: number; conversation_id: number; role: string; text: string; api_content: string | null; model: string | null; meta: string; created_at: string }
const toMsg = (r: Row): ChatMessage => ({ id: r.id, conversationId: r.conversation_id, role: r.role as ChatMessage['role'], text: r.text, model: r.model, createdAt: r.created_at, meta: JSON.parse(r.meta || '{}') });

/** True when the provider is telling us the organization has no usable credit. */
export function isCreditError(e: unknown): boolean {
  if (!(e instanceof Anthropic.APIError)) return false;
  const type = (e.error as any)?.error?.type ?? '';
  return type === 'billing_error' || /credit balance|insufficient credit|billing/i.test(e.message);
}

export class ChatEngine {
  private active = new Map<string, { abort: () => void; cancelled: boolean }>();

  constructor(private d: EngineDeps) {}

  // ---------- conversations ----------
  listConversations(): Conversation[] {
    return (this.d.db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 100').all() as any[])
      .map((r) => ({ id: r.id, title: r.title, mode: r.mode, videoId: r.video_id, createdAt: r.created_at, updatedAt: r.updated_at }));
  }
  messages(conversationId: number): ChatMessage[] {
    return (this.d.db.prepare("SELECT * FROM messages WHERE conversation_id = ? AND role != 'api' ORDER BY id").all(conversationId) as unknown as Row[]).map(toMsg);
  }
  createConversation(mode: ChatMode, title: string, videoId: number | null): number {
    const t = nowIso();
    const r = this.d.db.prepare('INSERT INTO conversations(title, mode, system_prompt, video_id, created_at, updated_at) VALUES(?,?,?,?,?,?)')
      .run(title.slice(0, 80) || 'New conversation', mode, buildSystemPrompt(this.d.settings(), mode), videoId, t, t);
    return Number(r.lastInsertRowid);
  }
  deleteConversation(id: number): void {
    tx(this.d.db, () => { this.d.db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id); this.d.db.prepare('DELETE FROM conversations WHERE id = ?').run(id); });
  }
  clearAllHistory(): void { this.d.db.exec('DELETE FROM messages; DELETE FROM conversations;'); }

  /** A local (no-model) exchange, e.g. a channel briefing. Kept out of what is sent to the API. */
  addLocalExchange(conversationId: number | null, question: string, answer: string, kind: string): { conversationId: number; messages: ChatMessage[] } {
    const cid = conversationId ?? this.createConversation('conversation', question, null);
    const ins = this.d.db.prepare("INSERT INTO messages(conversation_id, role, text, meta, created_at) VALUES(?, 'local', ?, ?, ?)");
    const a = ins.run(cid, question, JSON.stringify({ kind: 'user' }), nowIso());
    const b = ins.run(cid, answer, JSON.stringify({ kind }), nowIso());
    this.d.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(nowIso(), cid);
    const rows = this.d.db.prepare('SELECT * FROM messages WHERE id IN (?, ?) ORDER BY id').all(Number(a.lastInsertRowid), Number(b.lastInsertRowid)) as unknown as Row[];
    return { conversationId: cid, messages: rows.map(toMsg) };
  }

  private history(conversationId: number): Anthropic.MessageParam[] {
    const rows = this.d.db.prepare("SELECT * FROM messages WHERE conversation_id = ? AND role IN ('user','assistant','api') ORDER BY id").all(conversationId) as unknown as Row[];
    const out: Anthropic.MessageParam[] = [];
    for (const r of rows) {
      if (r.role === 'api') { out.push(JSON.parse(r.api_content!)); continue; }
      // Stored content is replayed exactly as it was sent or received (thinking blocks included).
      out.push({ role: r.role as 'user' | 'assistant', content: r.api_content ? JSON.parse(r.api_content) : r.text });
    }
    return out;
  }

  cancel(turnId: string): void {
    const t = this.active.get(turnId);
    if (t) { t.cancelled = true; t.abort(); }
  }
  cancelAll(): void { for (const id of this.active.keys()) this.cancel(id); }
  get busy(): boolean { return this.active.size > 0; }

  private tools(s: Settings): Anthropic.ToolUnion[] {
    const tools: Anthropic.ToolUnion[] = [...TOOL_DEFS];
    if (s.ai.webResearch) tools.push({ type: 'web_search_20260209', name: 'web_search', max_uses: s.ai.maxSearchesPerTurn });
    return tools;
  }

  private async countInput(client: Anthropic, params: { model: string; system: Anthropic.TextBlockParam[]; tools: Anthropic.ToolUnion[]; messages: Anthropic.MessageParam[] }, signal: AbortSignal): Promise<number> {
    try {
      const r = await client.messages.countTokens(params as any, { signal, timeout: 15_000, maxRetries: 0 });
      return Math.ceil(r.input_tokens * 1.05) + 200;
    } catch (e) {
      if (e instanceof Anthropic.APIUserAbortError) throw e;
      // Offline or the endpoint refused: fall back to a deliberately high local estimate.
      return estimateTokens(JSON.stringify([params.system, params.tools, params.messages]));
    }
  }

  /**
   * One user turn. Emits ChatEvents; resolves when the turn is finished, blocked or cancelled.
   * Nothing is persisted until the turn's outcome is known, so history is always append-only and valid.
   */
  async send(input: { turnId: string; conversationId: number | null; text: string; mode: ChatMode; videoId?: number | null; viaVoice?: boolean; extraContext?: string }): Promise<void> {
    const { emit, budget, db, store } = this.d;
    const s = this.d.settings();
    const turnId = input.turnId;
    const text = input.text.trim();
    if (!text) return;
    if (text.length > 60_000) { emit({ type: 'blocked', turnId, reason: 'error', message: 'That message is too long to send in one go.' }); return; }

    const pre = budget.status();
    if (pre.state !== 'ok') { emit({ type: 'blocked', turnId, reason: pre.state, message: pre.message }); return; }
    const client = this.d.client();
    if (!client) { emit({ type: 'blocked', turnId, reason: 'no_key', message: 'No API key is stored yet.' }); return; }

    const conv = input.conversationId ? (db.prepare('SELECT * FROM conversations WHERE id = ?').get(input.conversationId) as any) : null;
    const mode: ChatMode = conv?.mode ?? input.mode;
    const model = mode === 'deep' ? s.ai.deepModel : s.ai.conversationModel;
    const effort = mode === 'deep' ? s.ai.deepEffort : s.ai.conversationEffort;
    if (!MODELS.some((m) => m.id === model)) { emit({ type: 'blocked', turnId, reason: 'model_unavailable', message: `No price is recorded for “${model}”, so its cost cannot be capped. Pick another model in Settings.` }); return; }

    const systemText: string = conv?.system_prompt ?? buildSystemPrompt(s, mode);
    const system: Anthropic.TextBlockParam[] = [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }];
    const tools = this.tools(s);
    const userContent: Anthropic.ContentBlockParam[] = [
      { type: 'text', text: buildContextBlock(store.search(text, 6), new Date(), input.extraContext) },
      { type: 'text', text },
    ];
    let messages: Anthropic.MessageParam[] = [...(conv ? this.history(conv.id) : []), { role: 'user', content: userContent }];
    const turnMessages: Anthropic.MessageParam[] = [];   // everything after the user message
    const controller = new AbortController();
    const state = { abort: () => controller.abort(), cancelled: false };
    this.active.set(turnId, state);

    let fullText = '';
    const notes: string[] = [];
    const sources: { url: string; title: string }[] = [];
    let cost = 0;
    let strippedOnce = false;
    let transientRetries = 0;

    const persist = (final: { cancelled: boolean; lastAssistant: Anthropic.ContentBlockParam[] | null }): { user: ChatMessage; assistant: ChatMessage | null; conversationId: number } =>
      tx(db, () => {
        const cid = conv?.id ?? this.createConversationWithPrompt(mode, text, input.videoId ?? null, systemText);
        const ins = db.prepare('INSERT INTO messages(conversation_id, role, text, api_content, model, meta, created_at) VALUES(?,?,?,?,?,?,?)');
        const u = ins.run(cid, 'user', text, JSON.stringify(userContent), null, JSON.stringify({ viaVoice: !!input.viaVoice }), nowIso());
        let assistantId: number | null = null;
        if (!final.cancelled) {
          for (const m of turnMessages.slice(0, -1)) ins.run(cid, 'api', '', JSON.stringify(m), model, '{}', nowIso());
          const a = ins.run(cid, 'assistant', fullText, JSON.stringify(final.lastAssistant), model, JSON.stringify({ toolNotes: notes, sources, costUsd: cost }), nowIso());
          assistantId = Number(a.lastInsertRowid);
        } else if (fullText.trim()) {
          // A cancelled turn keeps only what was visibly said, as plain text; half-finished tool rounds are dropped.
          const a = ins.run(cid, 'assistant', fullText, null, model, JSON.stringify({ cancelled: true, toolNotes: notes, costUsd: cost }), nowIso());
          assistantId = Number(a.lastInsertRowid);
        }
        db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(nowIso(), cid);
        const get = (id: number) => toMsg(db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as unknown as Row);
        return { user: get(Number(u.lastInsertRowid)), assistant: assistantId ? get(assistantId) : null, conversationId: cid };
      });

    const finishCancelled = () => {
      const p = persist({ cancelled: true, lastAssistant: null });
      emit({ type: 'cancelled', turnId, userMessage: p.user, message: p.assistant ?? undefined });
    };

    try {
      emit({ type: 'start', turnId, model, conversationId: conv?.id ?? 0 });
      for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
        const maxTokens = MAX_TOKENS[mode];
        const inputTokens = await this.countInput(client, { model, system, tools, messages }, controller.signal);
        const hold = budget.reserve({ model, purpose: iter === 0 ? `${mode} reply` : `${mode} reply (step ${iter + 1})`, maxUsd: maxCost(model, inputTokens, maxTokens, s.ai.webResearch ? s.ai.maxSearchesPerTurn : 0) });
        if (!hold.ok) {
          if (iter === 0) { emit({ type: 'blocked', turnId, reason: hold.state, message: hold.message }); return; }
          // Mid-turn: keep what was produced so far instead of losing it.
          fullText += `\n\n_Stopped here: ${hold.message}_`;
          const p = persist({ cancelled: true, lastAssistant: null });
          emit({ type: 'blocked', turnId, reason: hold.state, message: hold.message, userMessage: p.user });
          return;
        }

        let streamStarted = false;
        let message: Anthropic.Message;
        try {
          const stream = client.messages.stream(
            { model, max_tokens: maxTokens, system, tools, messages, thinking: { type: 'adaptive' }, output_config: { effort } },
            { signal: controller.signal, maxRetries: 0 },
          );
          stream.on('streamEvent', () => { streamStarted = true; });
          stream.on('text', (delta) => { fullText += delta; emit({ type: 'text', turnId, delta }); });
          message = await stream.finalMessage();
        } catch (e) {
          if (state.cancelled || e instanceof Anthropic.APIUserAbortError) {
            // Tokens generated before the cancel are billed, and we cannot know how many: keep the hold.
            budget.markUncertain(hold.id, 'Cancelled while the request was in flight');
            finishCancelled();
            return;
          }
          if (e instanceof Anthropic.APIError && e.status !== undefined && !streamStarted) {
            // The API answered with an error status instead of a response: nothing was generated or billed.
            budget.release(hold.id, `Rejected by the API (${e.status})`);
            if (isCreditError(e)) { budget.setProviderBlocked('insufficient credit'); emit({ type: 'blocked', turnId, reason: 'provider_blocked', message: budget.status().message }); return; }
            if (e instanceof Anthropic.BadRequestError && /thinking|signature/i.test(e.message) && !strippedOnce) {
              // Saved reasoning no longer matches this conversation (e.g. tools changed): drop it once and retry.
              strippedOnce = true;
              messages = messages.map((m) => (typeof m.content === 'string' ? m : ({ ...m, content: (m.content as Anthropic.ContentBlockParam[]).filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking') } as Anthropic.MessageParam)));
              iter--; continue;
            }
            if ((e.status === 429 || e.status === 529 || e.status >= 500) && transientRetries < 1) {
              transientRetries++;
              await new Promise((r) => setTimeout(r, 2000));
              if (state.cancelled) { finishCancelled(); return; }
              iter--; continue;
            }
            let msg: string; let reason: 'error' | 'model_unavailable' | 'no_key' = 'error';
            if (e instanceof Anthropic.AuthenticationError) { msg = 'Anthropic did not accept the stored API key. Replace it in Settings → Claude.'; reason = 'no_key'; }
            else if (e instanceof Anthropic.NotFoundError || e instanceof Anthropic.PermissionDeniedError) { msg = `This API key cannot use ${model}. I have not switched to another model — choose one in Settings → Claude.`; reason = 'model_unavailable'; }
            else if (e instanceof Anthropic.RateLimitError) msg = 'Anthropic is rate-limiting this key right now. Try again in a minute.';
            else if (e.status >= 500) msg = 'Anthropic’s service is having trouble right now. Nothing was charged for that attempt; try again shortly.';
            else msg = `The request was rejected (${e.status}): ${e.message.slice(0, 300)}`;
            if (iter > 0 && fullText.trim()) { const p = persist({ cancelled: true, lastAssistant: null }); emit({ type: 'blocked', turnId, reason, message: msg, userMessage: p.user }); }
            else emit({ type: 'blocked', turnId, reason, message: msg });
            return;
          }
          // Connection lost, timed out, or failed after output began: the charge is unknown.
          budget.markUncertain(hold.id, streamStarted ? 'Connection lost during the reply' : 'No response received; the request may still have been processed');
          const offline = e instanceof Anthropic.APIConnectionError;
          const msg = offline ? 'I couldn’t reach Anthropic — you seem to be offline. Notes, the avatar and saved stats still work. The possible charge for that attempt is held in the budget until you resolve it.' : `The reply failed part-way (${(e as Error).message.slice(0, 200)}). Its possible charge is held in the budget until you resolve it.`;
          if (fullText.trim()) { const p = persist({ cancelled: true, lastAssistant: null }); emit({ type: 'blocked', turnId, reason: offline ? 'offline' : 'error', message: msg, userMessage: p.user }); }
          else emit({ type: 'blocked', turnId, reason: offline ? 'offline' : 'error', message: msg });
          return;
        }

        const stepCost = costFromUsage(model, message.usage);
        budget.settle(hold.id, stepCost, message.usage);
        cost += stepCost;

        for (const b of message.content) {
          if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) for (const r of b.content) if (r.type === 'web_search_result') sources.push({ url: r.url, title: r.title });
          if (b.type === 'server_tool_use' && b.name === 'web_search') { const n = 'Searched the web'; notes.push(n); emit({ type: 'tool', turnId, note: n }); }
        }

        if (message.stop_reason === 'refusal') {
          emit({ type: 'blocked', turnId, reason: 'refused', message: `${MODELS.find((m) => m.id === model)?.name ?? model} declined this request${message.stop_details?.explanation ? `: ${message.stop_details.explanation}` : '.'} I have not passed it to a different model. You can rephrase, or pick another model in Settings.` });
          return;
        }

        const assistantContent = message.content as unknown as Anthropic.ContentBlockParam[];
        turnMessages.push({ role: 'assistant', content: assistantContent });
        messages = [...messages, { role: 'assistant', content: assistantContent }];

        if (message.stop_reason === 'pause_turn') continue;

        const toolUses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
        if (message.stop_reason === 'tool_use' && toolUses.length) {
          if (iter === MAX_ITERATIONS - 1) { fullText += '\n\n_I stopped here because this turn reached its step limit._'; }
          const results: Anthropic.ToolResultBlockParam[] = toolUses.map((tu) => {
            const out = TOOL_NAMES.has(tu.name) ? runTool(this.d.tools, tu.name, tu.input) : { content: `Unknown tool "${tu.name}".`, isError: true, note: null };
            if (out.note) { notes.push(out.note); emit({ type: 'tool', turnId, note: out.note }); }
            return { type: 'tool_result', tool_use_id: tu.id, content: out.content, is_error: out.isError };
          });
          const resultMsg: Anthropic.MessageParam = { role: 'user', content: results };
          turnMessages.push(resultMsg);
          messages = [...messages, resultMsg];
          if (iter === MAX_ITERATIONS - 1) {
            // Close the round so stored history stays valid, then end the turn without another request.
            const closing: Anthropic.ContentBlockParam[] = [{ type: 'text', text: '(Step limit reached for this turn.)' }];
            turnMessages.push({ role: 'assistant', content: closing });
            break;
          }
          if (fullText && !fullText.endsWith('\n')) { fullText += '\n\n'; emit({ type: 'text', turnId, delta: '\n\n' }); }
          continue;
        }
        if (message.stop_reason === 'max_tokens') {
          const cut = '\n\n_This reply hit its length limit. Ask me to continue if you want the rest._';
          fullText += cut; emit({ type: 'text', turnId, delta: cut });
          if (toolUses.length) {
            // A truncated tool call must not run; answer it with an error so the stored round is complete.
            const errs: Anthropic.ToolResultBlockParam[] = toolUses.map((tu) => ({ type: 'tool_result', tool_use_id: tu.id, content: 'Not run: the call was cut off by the output limit.', is_error: true }));
            turnMessages.push({ role: 'user', content: errs }, { role: 'assistant', content: [{ type: 'text', text: '(Reply cut off by the length limit.)' }] });
          }
        }
        break;
      }

      const last = turnMessages[turnMessages.length - 1];
      const p = persist({ cancelled: false, lastAssistant: last.content as Anthropic.ContentBlockParam[] });
      emit({ type: 'done', turnId, message: p.assistant!, userMessage: p.user, speak: shortSpoken(fullText) });
    } catch (e) {
      if (state.cancelled || e instanceof Anthropic.APIUserAbortError) { finishCancelled(); return; }
      emit({ type: 'blocked', turnId, reason: 'error', message: `Something went wrong inside the app: ${(e as Error).message}` });
    } finally {
      this.active.delete(turnId);
    }
  }

  private createConversationWithPrompt(mode: ChatMode, title: string, videoId: number | null, systemPrompt: string): number {
    const t = nowIso();
    const r = this.d.db.prepare('INSERT INTO conversations(title, mode, system_prompt, video_id, created_at, updated_at) VALUES(?,?,?,?,?,?)')
      .run(title.replace(/\s+/g, ' ').slice(0, 80), mode, systemPrompt, videoId, t, t);
    return Number(r.lastInsertRowid);
  }

  /**
   * Brain dump: one bounded request that proposes where each idea, task or note should be saved.
   * Nothing is saved here — the panel shows the preview and Gavin applies it.
   */
  async brainDump(transcript: string, signal?: AbortSignal): Promise<{ ok: true; items: BrainDumpItem[]; costUsd: number } | { ok: false; message: string }> {
    const { budget, store } = this.d;
    const s = this.d.settings();
    const client = this.d.client();
    const st = budget.status();
    if (st.state !== 'ok' || !client) return { ok: false, message: st.message };
    const model = s.ai.conversationModel;
    const videos = store.listVideos().slice(0, 40).map((v) => ({ id: v.id, title: v.title, stage: v.stage }));
    const prompt = `Gavin recorded this brain dump for his Minecraft YouTube channel. Pull out the distinct useful items without adding ideas of your own.\n\nFor each item give: type (idea = a possible new video; task = something to do; note = detail for an existing video; decision = something he has decided or ruled out), a short title, the text in his words tidied up, and video_id (the id of the existing video it belongs to, or null).\n\nExisting videos: ${JSON.stringify(videos)}\n\n<transcript>\n${transcript}\n</transcript>`;
    const maxTokens = 4000;
    const hold = budget.reserve({ model, purpose: 'brain dump', maxUsd: maxCost(model, estimateTokens(prompt), maxTokens) });
    if (!hold.ok) return { ok: false, message: hold.message };
    try {
      const res = await client.messages.create({
        model, max_tokens: maxTokens, output_config: { effort: 'low', format: { type: 'json_schema', schema: {
          type: 'object', additionalProperties: false, required: ['items'],
          properties: { items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['type', 'title', 'text', 'video_id'],
            properties: { type: { type: 'string', enum: ['idea', 'task', 'note', 'decision'] }, title: { type: 'string' }, text: { type: 'string' }, video_id: { type: ['integer', 'null'] } } } } },
        } } },
        messages: [{ role: 'user', content: prompt }],
      }, { signal, maxRetries: 0 });
      const cost = costFromUsage(model, res.usage);
      budget.settle(hold.id, cost, res.usage);
      if (res.stop_reason !== 'end_turn') return { ok: false, message: 'The model did not finish sorting the brain dump. The transcript itself is unchanged; try again or save it as a note.' };
      const textBlock = res.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
      const parsed = JSON.parse(textBlock?.text ?? '{}') as { items?: any[] };
      const ids = new Set(videos.map((v) => v.id));
      const items: BrainDumpItem[] = (parsed.items ?? []).filter((i) => i && typeof i.title === 'string' && typeof i.text === 'string' && ['idea', 'task', 'note', 'decision'].includes(i.type)).slice(0, 40).map((i) => {
        const videoId = typeof i.video_id === 'number' && ids.has(i.video_id) ? i.video_id : null;
        const vt = videoId ? videos.find((v) => v.id === videoId)!.title : null;
        const target = i.type === 'idea' ? 'New video card (stage: Idea)' : i.type === 'task' ? `Next action${vt ? ` on “${vt}”` : ''}` : i.type === 'decision' ? `Decision${vt ? ` on “${vt}”` : ''} in memory` : vt ? `Note on “${vt}”` : 'General note';
        return { type: i.type, title: i.title.slice(0, 200), text: i.text.slice(0, 4000), videoId, target };
      });
      return { ok: true, items, costUsd: cost };
    } catch (e) {
      if (e instanceof Anthropic.APIError && e.status !== undefined) {
        budget.release(hold.id, `Rejected by the API (${e.status})`);
        if (isCreditError(e)) budget.setProviderBlocked('insufficient credit');
        return { ok: false, message: `The request was rejected (${e.status}). Nothing was charged.` };
      }
      budget.markUncertain(hold.id, 'Brain dump request did not complete');
      return { ok: false, message: 'The request did not complete. Its possible charge is held in the budget.' };
    }
  }

  /** Which configured models this key can actually use. The models endpoint is free. */
  async modelInfo(): Promise<ModelInfo[]> {
    const client = this.d.client();
    let ids: Set<string> | null = null;
    if (client) {
      try { ids = new Set(); for await (const m of client.models.list({ limit: 100 }, { maxRetries: 0, timeout: 15_000 })) ids.add(m.id); } catch { ids = null; }
    }
    return MODELS.map((m) => ({ id: m.id, name: m.name, available: ids ? ids.has(m.id) : null, inputPerMTok: m.input, outputPerMTok: m.output }));
  }
}

/** Applies a previewed brain dump as one undoable batch. The raw transcript is always kept. */
export function applyBrainDump(store: Store, transcript: string, items: BrainDumpItem[], videoId: number | null): { saved: number } {
  return store.batch('Brain dump', () => {
    store.saveDocument({ videoId, kind: 'voice_note', title: `Brain dump ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, content: transcript, author: 'gavin' });
    let saved = 0;
    for (const i of items) {
      if (i.type === 'idea') store.createVideo({ title: i.title, premise: i.text, format: 'long', stage: 'Idea' });
      else if (i.type === 'task') store.addMemory({ kind: 'next_action', text: `${i.title}: ${i.text}`, videoId: i.videoId, provenance: 'gavin' });
      else if (i.type === 'decision') store.addMemory({ kind: 'accepted', text: `${i.title}: ${i.text}`, videoId: i.videoId, provenance: 'gavin' });
      else store.saveDocument({ videoId: i.videoId, kind: 'note', title: i.title, content: i.text, author: 'gavin' });
      saved++;
    }
    return { saved };
  });
}
