import { describe, expect, it } from 'vitest';
import { Budget } from '../src/main/budget';
import { openDb } from '../src/main/db';
import { costFromUsage, maxCost } from '../src/main/pricing';

const mk = (hasKey = true) => { const db = openDb(':memory:'); return { db, b: new Budget(db, () => hasKey) }; };
const verify = (b: Budget, over: Partial<Parameters<Budget['verify']>[0]> = {}, now?: Date) => b.verify({ allowanceUsd: 20, expiresAt: null, reserveUsd: 5, monthlyCapUsd: null, spendingVerified: true, ...over }, now);

describe('budget gate', () => {
  it('fails closed until a key, the checklist and an allowance are all present', () => {
    expect(mk(false).b.status().state).toBe('no_key');
    const { b } = mk();
    expect(b.status().state).toBe('unverified');
    expect(b.reserve({ model: 'claude-opus-5-5', purpose: 't', maxUsd: 0.01 }).ok).toBe(false);
    verify(b, { spendingVerified: false });
    expect(b.status().state).toBe('unverified');
    verify(b);
    expect(b.status().state).toBe('ok');
  });

  it('blocks at expiry using the stored expiry date, not the calendar month', () => {
    const { b } = mk();
    verify(b, { expiresAt: '2026-11-20T08:00:00Z' });
    expect(b.status(new Date('2026-11-20T07:59:00Z')).state).toBe('ok');
    expect(b.status(new Date('2026-11-20T08:00:00Z')).state).toBe('expired');
    expect(b.reserve({ model: 'm', purpose: 't', maxUsd: 0.01 }, new Date('2026-11-21T00:00:00Z')).ok).toBe(false);
  });

  it('keeps the reserve untouched and refuses a request that does not fit', () => {
    const { b } = mk();
    verify(b);                                           // $20 with $5 reserve → $15 usable
    const big = b.reserve({ model: 'm', purpose: 't', maxUsd: 15.01 });
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.state).toBe('exhausted');
    expect(b.reserve({ model: 'm', purpose: 't', maxUsd: 15 }).ok).toBe(true);
    expect(b.status().state).toBe('exhausted');          // fully held
  });

  it('never lets concurrent reservations spend the same remainder', () => {
    const { b } = mk();
    verify(b);
    const results = Array.from({ length: 10 }, () => b.reserve({ model: 'm', purpose: 't', maxUsd: 4 }));
    expect(results.filter((r) => r.ok)).toHaveLength(3);  // 3 × $4 = $12 ≤ $15; a fourth would exceed
    expect(b.status().heldUsd).toBe(12);
  });

  it('settles to actual cost, releases only unbilled requests, and holds uncertain ones in full', () => {
    const { b } = mk();
    verify(b);
    const a = b.reserve({ model: 'm', purpose: 'a', maxUsd: 2 }); const c = b.reserve({ model: 'm', purpose: 'c', maxUsd: 2 }); const d = b.reserve({ model: 'm', purpose: 'd', maxUsd: 2 });
    if (!a.ok || !c.ok || !d.ok) throw new Error('reserve failed');
    b.settle(a.id, 0.25); b.release(c.id, 'rejected 400'); b.markUncertain(d.id, 'cancelled');
    const s = b.status();
    expect(s.settledUsd).toBe(0.25);
    expect(s.heldUsd).toBe(2);                            // cancellation is not free
    expect(s.remainingUsd).toBe(20 - 5 - 0.25 - 2);
    b.release(d.id, 'should not work');                   // an uncertain entry cannot be waved away
    expect(b.status().heldUsd).toBe(2);
    b.resolveUncertain(d.id, 0.4);
    expect(b.status().heldUsd).toBe(0);
    expect(b.status().settledUsd).toBeCloseTo(0.65);
  });

  it('turns reservations left open by a crash into held, uncertain entries', () => {
    const { db, b } = mk();
    verify(b);
    b.reserve({ model: 'm', purpose: 't', maxUsd: 3 });
    const again = new Budget(db, () => true);
    expect(again.ledger()[0].status).toBe('uncertain');
    expect(again.status().heldUsd).toBe(3);
  });

  it('re-bases usage when the allowance is re-entered, and clears a provider block', () => {
    const { b } = mk();
    verify(b, {}, new Date('2026-11-01T00:00:00Z'));
    const r = b.reserve({ model: 'm', purpose: 't', maxUsd: 1 }, new Date('2026-11-02T00:00:00Z'));
    if (r.ok) b.settle(r.id, 1);
    b.setProviderBlocked('insufficient credit');
    expect(b.status(new Date('2026-11-03T00:00:00Z')).state).toBe('provider_blocked');
    verify(b, { allowanceUsd: 12 }, new Date('2026-11-04T00:00:00Z'));   // figure from the Console already includes outside use
    const s = b.status(new Date('2026-11-05T00:00:00Z'));
    expect(s.state).toBe('ok'); expect(s.settledUsd).toBe(0); expect(s.remainingUsd).toBe(7);
    expect(s.monthUsd).toBe(1);                                          // the calendar-month figure is a separate boundary
  });

  it('enforces the optional calendar-month cap independently of the allowance', () => {
    const { b } = mk();
    verify(b, { allowanceUsd: 100, monthlyCapUsd: 3 });
    expect(b.reserve({ model: 'm', purpose: 't', maxUsd: 2 }).ok).toBe(true);
    expect(b.reserve({ model: 'm', purpose: 't', maxUsd: 2 }).ok).toBe(false);
  });

  it('rejects unbounded or nonsensical inputs', () => {
    const { b } = mk();
    expect(() => verify(b, { allowanceUsd: NaN })).toThrow();
    expect(() => verify(b, { expiresAt: 'soon' })).toThrow();
    verify(b);
    expect(b.reserve({ model: 'm', purpose: 't', maxUsd: Infinity }).ok).toBe(false);
    expect(b.reserve({ model: 'm', purpose: 't', maxUsd: 0 }).ok).toBe(false);
  });
});

describe('pricing', () => {
  it('prices usage including cache writes, cache reads and web searches', () => {
    const cost = costFromUsage('claude-fable-5-2', { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 1_000_000, cache_creation: { ephemeral_5m_input_tokens: 100_000, ephemeral_1h_input_tokens: 100_000 }, server_tool_use: { web_search_requests: 3 } });
    expect(cost).toBeCloseTo(8 + 4 + 0.2 + 1 + 1.6 + 0.03, 6);
    expect(costFromUsage('claude-opus-5-5', { input_tokens: 500, output_tokens: 500, cache_creation_input_tokens: 1000 })).toBeCloseTo((500 * 4 + 500 * 20 + 1000 * 5) / 1e6, 9);
  });
  it('always reserves at least what the request can cost', () => {
    const worst = costFromUsage('claude-opus-5-5', { input_tokens: 0, cache_creation_input_tokens: 10_000, output_tokens: 8000, server_tool_use: { web_search_requests: 2 } });
    expect(maxCost('claude-opus-5-5', 10_000, 8000, 2)).toBeGreaterThanOrEqual(worst);
  });
  it('refuses to bound a model with no recorded price', () => { expect(() => maxCost('claude-unknown', 1, 1)).toThrow(); });
});
