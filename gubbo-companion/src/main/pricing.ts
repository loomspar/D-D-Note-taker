// Prices checked against https://platform.claude.com/docs/en/about-claude/pricing on 2026-11-14.
// USD per million tokens. Recheck when Anthropic changes prices; the Budget screen shows this date.
export const PRICING_CHECKED = '2026-11-14';

export interface ModelPrice { id: string; name: string; input: number; output: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number }

export const MODELS: ModelPrice[] = [
  { id: 'claude-fable-5-2', name: 'Claude Fable 5.2', input: 8, output: 40, cacheWrite5m: 10, cacheWrite1h: 16, cacheRead: 0.2 },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1 },
];

/** Web search server tool: $10 per 1,000 searches, plus the result tokens as input. */
export const WEB_SEARCH_USD = 0.01;
/** Conservative allowance for search-result tokens added to the context per search. */
export const WEB_SEARCH_RESULT_TOKENS = 12_000;

export function priceFor(model: string): ModelPrice {
  const p = MODELS.find((m) => m.id === model);
  if (!p) throw new Error(`No price is recorded for model "${model}", so its cost cannot be bounded.`);
  return p;
}

export interface UsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
}

/** Cost of a completed response from the usage the API returned. Thinking tokens are part of output_tokens. */
export function costFromUsage(model: string, u: UsageLike): number {
  const p = priceFor(model);
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const w5m = u.cache_creation ? (u.cache_creation.ephemeral_5m_input_tokens ?? 0) : (u.cache_creation_input_tokens ?? 0);
  const tokens =
    (u.input_tokens ?? 0) * p.input +
    (u.output_tokens ?? 0) * p.output +
    w5m * p.cacheWrite5m + w1h * p.cacheWrite1h +
    (u.cache_read_input_tokens ?? 0) * p.cacheRead;
  return tokens / 1e6 + (u.server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH_USD;
}

/**
 * Upper bound for one request before it is sent. Input is priced at the cache-write rate (the dearest
 * rate an input token can be billed at here), output at the full max_tokens, and each allowed search at
 * its fee plus a generous block of result tokens.
 */
export function maxCost(model: string, inputTokens: number, maxOutputTokens: number, maxSearches = 0): number {
  const p = priceFor(model);
  const input = inputTokens + maxSearches * WEB_SEARCH_RESULT_TOKENS;
  return (input * p.cacheWrite5m + maxOutputTokens * p.output) / 1e6 + maxSearches * WEB_SEARCH_USD;
}

/** Rough token estimate when the count_tokens endpoint is unreachable. Deliberately high. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2.5) + 400;
}
