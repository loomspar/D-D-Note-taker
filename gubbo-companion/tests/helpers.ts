import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatEvent, Settings } from '../src/shared/types';
import { ChatEngine } from '../src/main/ai';
import { Budget } from '../src/main/budget';
import { openDb } from '../src/main/db';
import { DEFAULT_SETTINGS } from '../src/main/settings';
import { Store } from '../src/main/store';

export const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gubbo-test-'));

export const usage = (input: number, output: number, extra: Record<string, unknown> = {}) => ({ input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...extra });

export const textMessage = (text: string, u = usage(1000, 200)) => ({ id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: u });
export const toolMessage = (name: string, input: unknown, u = usage(1000, 100)) => ({ id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: `tu_${name}`, name, input }], stop_reason: 'tool_use', stop_sequence: null, usage: u });

type Step = { message: any } | { error: unknown } | { hang: true; emit?: string };

/** Minimal stand-in for the Anthropic client: scripted streams, real abort semantics, request log. */
export function fakeClient(steps: Step[]) {
  const requests: any[] = [];
  const client = {
    requests,
    messages: {
      countTokens: async () => ({ input_tokens: 1000 }),
      create: async (params: any) => { requests.push(params); const s = steps.shift(); if (!s) throw new Error('no scripted step'); if ('error' in s) throw s.error; return (s as any).message; },
      stream: (params: any, opts: { signal?: AbortSignal }) => {
        requests.push(structuredClone(params));
        const step = steps.shift();
        const handlers: Record<string, ((x: any) => void)[]> = {};
        return {
          on(ev: string, fn: (x: any) => void) { (handlers[ev] ??= []).push(fn); return this; },
          async finalMessage() {
            if (!step) throw new Error('no scripted step');
            if ('error' in step) throw step.error;
            if ('hang' in step) {
              if (step.emit) { handlers.streamEvent?.forEach((f) => f({})); handlers.text?.forEach((f) => f(step.emit)); }
              return new Promise((_, reject) => opts.signal?.addEventListener('abort', () => reject(new Anthropic.APIUserAbortError())));
            }
            handlers.streamEvent?.forEach((f) => f({}));
            for (const b of step.message.content) if (b.type === 'text') handlers.text?.forEach((f) => f(b.text));
            return step.message;
          },
        };
      },
    },
    models: { list: () => ({ async *[Symbol.asyncIterator]() { yield { id: 'claude-opus-5-5' }; } }) },
  };
  return client;
}

export function apiError(status: number, type: string, message: string) {
  return Anthropic.APIError.generate(status, { type: 'error', error: { type, message } }, message, new Headers());
}

export function setup(opts: { file?: string; steps?: Step[]; hasKey?: boolean; settings?: Partial<Settings>; verified?: boolean; allowance?: number } = {}) {
  const db = openDb(opts.file ?? ':memory:');
  const store = new Store(db);
  const hasKey = opts.hasKey ?? true;
  const budget = new Budget(db, () => hasKey);
  if (opts.verified ?? true) budget.verify({ allowanceUsd: opts.allowance ?? 50, expiresAt: null, reserveUsd: 5, monthlyCapUsd: null, spendingVerified: true });
  const settings = { ...DEFAULT_SETTINGS, ...opts.settings } as Settings;
  const client = fakeClient(opts.steps ?? []);
  const events: ChatEvent[] = [];
  const engine = new ChatEngine({
    db, store, budget, settings: () => settings, client: () => (hasKey ? (client as unknown as Anthropic) : null),
    tools: { store, settings: () => settings, channelReport: () => ({ report: null, stale: false, connected: false }) },
    emit: (e) => events.push(e),
  });
  return { db, store, budget, engine, client, events, settings };
}
