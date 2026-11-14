import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyBrainDump } from '../src/main/ai';
import { apiError, setup, textMessage, tmpDir, toolMessage, usage } from './helpers';

const send = (e: ReturnType<typeof setup>, text: string, conversationId: number | null = null, turnId = 't1') => e.engine.send({ turnId, conversationId, text, mode: 'conversation' });
const last = (e: ReturnType<typeof setup>) => e.events[e.events.length - 1];

describe('chat engine', () => {
  it('blocks before dispatch when credit is unverified or exhausted', async () => {
    const unverified = setup({ verified: false, steps: [{ message: textMessage('hi') }] });
    await send(unverified, 'hello');
    expect(last(unverified)).toMatchObject({ type: 'blocked', reason: 'unverified' });
    expect(unverified.client.requests).toHaveLength(0);

    const broke = setup({ allowance: 5.1, steps: [{ message: textMessage('hi') }] });   // $0.10 usable; a reply can cost more
    await send(broke, 'hello');
    expect(last(broke)).toMatchObject({ type: 'blocked', reason: 'exhausted' });
    expect(broke.client.requests).toHaveLength(0);
    expect(broke.budget.ledger()).toHaveLength(0);
  });

  it('sends the selected model, settles the real cost and persists the turn', async () => {
    const e = setup({ steps: [{ message: textMessage('Short answer. More detail.', usage(2000, 500)) }] });
    await send(e, 'Give me an idea');
    const done = last(e);
    expect(done.type).toBe('done');
    expect(e.client.requests[0].model).toBe('claude-opus-5-5');
    expect(e.client.requests[0].output_config.effort).toBe('medium');
    expect(e.client.requests[0].fallbacks).toBeUndefined();            // never silently reroutes to another model
    const entry = e.budget.ledger()[0];
    expect(entry.status).toBe('settled');
    expect(entry.actualUsd).toBeCloseTo((2000 * 4 + 500 * 20) / 1e6, 9);
    expect(entry.reservedUsd).toBeGreaterThan(entry.actualUsd!);
    if (done.type === 'done') expect(e.engine.messages(done.message.conversationId).map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('holds the full reservation when a request is cancelled mid-flight', async () => {
    const e = setup({ steps: [{ hang: true, emit: 'Partial ans' }] });
    const p = send(e, 'long question');
    await new Promise((r) => setTimeout(r, 20));
    e.engine.cancel('t1');
    await p;
    expect(last(e).type).toBe('cancelled');
    const entry = e.budget.ledger()[0];
    expect(entry.status).toBe('uncertain');
    expect(e.budget.status().heldUsd).toBe(entry.reservedUsd);
    expect(e.budget.status().settledUsd).toBe(0);
    const ev = last(e);
    if (ev.type === 'cancelled') expect(ev.message?.meta.cancelled).toBe(true);
  });

  it('holds the reservation on a dropped connection but releases it on an explicit API rejection', async () => {
    const dropped = setup({ steps: [{ error: new Anthropic.APIConnectionError({ message: 'socket hang up' }) }] });
    await send(dropped, 'hi');
    expect(last(dropped)).toMatchObject({ type: 'blocked', reason: 'offline' });
    expect(dropped.budget.ledger()[0].status).toBe('uncertain');

    const rejected = setup({ steps: [{ error: apiError(400, 'invalid_request_error', 'bad field') }] });
    await send(rejected, 'hi');
    expect(rejected.budget.ledger()[0].status).toBe('released');
    expect(rejected.budget.status().heldUsd).toBe(0);
  });

  it('retries a rate-limited request once at most, without double-charging', async () => {
    const e = setup({ steps: [{ error: apiError(429, 'rate_limit_error', 'slow down') }, { error: apiError(429, 'rate_limit_error', 'slow down') }, { message: textMessage('never reached') }] });
    await send(e, 'hi');
    expect(e.client.requests).toHaveLength(2);
    expect(last(e).type).toBe('blocked');
    expect(e.budget.ledger().every((l) => l.status === 'released')).toBe(true);
  }, 10_000);

  it('latches a provider insufficient-credit response and stops further requests', async () => {
    const e = setup({ steps: [{ error: apiError(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API.') }, { message: textMessage('should not be sent') }] });
    await send(e, 'hi');
    expect(last(e)).toMatchObject({ type: 'blocked', reason: 'provider_blocked' });
    await send(e, 'again', null, 't2');
    expect(e.client.requests).toHaveLength(1);
    expect(e.budget.status().state).toBe('provider_blocked');
  });

  it('does not substitute another model when the chosen one is unavailable or refuses', async () => {
    const missing = setup({ steps: [{ error: apiError(404, 'not_found_error', 'model not found') }] });
    await send(missing, 'hi');
    expect(last(missing)).toMatchObject({ type: 'blocked', reason: 'model_unavailable' });
    expect(missing.client.requests).toHaveLength(1);

    const refused = setup({ steps: [{ message: { ...textMessage(''), content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: 'declined' } } }] });
    await send(refused, 'hi');
    expect(last(refused)).toMatchObject({ type: 'blocked', reason: 'refused' });
    expect(refused.client.requests).toHaveLength(1);
    expect(refused.budget.ledger()[0].status).toBe('settled');
  });

  it('runs validated tools, reserves per step, and stores a history that replays unchanged', async () => {
    const e = setup({ steps: [
      { message: toolMessage('save_video_idea', { title: 'One Chunk, 100 Days', premise: 'Survive in a single chunk', format: 'long' }) },
      { message: textMessage('Saved it.') },
      { message: textMessage('Second reply.') },
    ] });
    await send(e, 'Save that idea');
    const done = last(e);
    expect(done.type).toBe('done');
    expect(e.store.listVideos().map((v) => v.title)).toEqual(['One Chunk, 100 Days']);
    expect(e.budget.ledger()).toHaveLength(2);
    if (done.type !== 'done') return;
    expect(done.message.meta.toolNotes?.[0]).toContain('Saved idea');
    const firstTurn = e.client.requests[1].messages;                   // user, assistant(tool_use), user(tool_result)
    await send(e, 'And another thing', done.message.conversationId, 't2');
    const replay = e.client.requests[2];
    expect(replay.messages.slice(0, firstTurn.length)).toEqual(firstTurn);   // append-only: earlier turns byte-identical
    expect(replay.messages[1].content[0].type).toBe('thinking');             // thinking blocks returned as received
    expect(replay.system).toEqual(e.client.requests[0].system);              // system prompt frozen for the conversation
  });

  it('returns invalid tool input to the model as an error instead of acting on it', async () => {
    const e = setup({ steps: [{ message: toolMessage('save_score', { video_id: 99, clarity: 25, emotion: 1, depth: 1, demand: 1, originality: 1, weakest: 'x', notes: '' }) }, { message: textMessage('ok') }] });
    await send(e, 'score it');
    const result = e.client.requests[1].messages[2].content[0];
    expect(result.is_error).toBe(true);
    expect(e.store.listVideos()).toHaveLength(0);
  });

  it('bounds the number of tool iterations in one turn', async () => {
    const e = setup({ allowance: 500, steps: Array.from({ length: 10 }, () => ({ message: toolMessage('list_videos', {}) })) });
    await send(e, 'loop');
    expect(e.client.requests).toHaveLength(6);
    expect(last(e).type).toBe('done');
  });

  it('keeps conversations and decisions across an application restart', async () => {
    const dir = tmpDir(); const file = path.join(dir, 'gubbo.db');
    const a = setup({ file, steps: [{ message: toolMessage('remember', { kind: 'rejected', text: 'Hardcore skyblock speedrun', reason: 'Too saturated; three near-identical videos this month', stated_by_gavin: true }) }, { message: textMessage('Noted.') }] });
    await send(a, 'Remember why I rejected the first version');
    const done = last(a); if (done.type !== 'done') throw new Error('not done');
    a.db.close();
    const b = setup({ file, verified: false });
    expect(b.budget.status().state).toBe('ok');                            // budget confirmation persisted too
    expect(b.engine.listConversations()).toHaveLength(1);
    expect(b.engine.messages(done.message.conversationId).map((m) => m.text)).toEqual(['Remember why I rejected the first version', 'Noted.']);
    const hit = b.store.search('why was skyblock rejected')[0];
    expect(hit.snippet).toContain('saturated');
    expect(hit.provenance).toBe('gavin');
    b.db.close(); fs.rmSync(dir, { recursive: true, force: true });
  });

  it('answers a brain dump with a preview only, then saves as one undoable batch', async () => {
    const e = setup({ steps: [{ message: textMessage(JSON.stringify({ items: [{ type: 'idea', title: 'Lava-only base', text: 'Build a base using only lava', video_id: null }, { type: 'task', title: 'Fix mic', text: 'Replace the pop filter', video_id: 123 }] })) }] });
    const r = await e.engine.brainDump('lava base idea... also fix my mic');
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(e.store.listVideos()).toHaveLength(0);                          // nothing saved by the preview
    expect(r.items[1].videoId).toBeNull();                                 // unknown video id from the model is dropped
    applyBrainDump(e.store, 'lava base idea... also fix my mic', r.items, null);
    expect(e.store.listVideos()).toHaveLength(1);
    expect(e.store.getDocument(e.store.listDocuments(null)[0].id)!.content).toBe('lava base idea... also fix my mic');
    const undo = e.store.undoList()[0];
    expect(undo.label).toBe('Brain dump');
    e.store.undo(undo.id);
    expect(e.store.listVideos()).toHaveLength(0);
    expect(e.store.listMemory()).toHaveLength(0);
  });
});
