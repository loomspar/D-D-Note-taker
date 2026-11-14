import type { BudgetConfig, BudgetState, BudgetStatus, LedgerEntry } from '../shared/types';
import { type DB, getSetting, setSetting, tx } from './db';

export const DEFAULT_BUDGET: BudgetConfig = {
  allowanceUsd: null, allowanceVerifiedAt: null, expiresAt: null,
  reserveUsd: 5, monthlyCapUsd: null, spendingVerified: false, providerBlocked: null,
};

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * Local, estimated record of what this app has spent. It is not the organization's credit balance:
 * other apps on the same Console organization draw on the same credit, which is why the figure is
 * re-based every time Gavin re-enters the balance shown in the Console.
 *
 * All methods are synchronous and each mutation runs in one SQLite transaction, so two requests can
 * never both reserve the same remaining dollars.
 */
export class Budget {
  constructor(private db: DB, private hasKey: () => boolean) {
    // A reservation still open at startup belongs to a request whose outcome was never recorded.
    db.prepare("UPDATE ledger SET status = 'uncertain', note = 'App closed before the result was recorded' WHERE status = 'reserved'").run();
  }

  config(): BudgetConfig { return { ...DEFAULT_BUDGET, ...getSetting<Partial<BudgetConfig>>(this.db, 'budget', {}) }; }

  /** Gavin confirms the Console balance and the no-extra-spending settings. Re-bases app usage. */
  verify(input: { allowanceUsd: number; expiresAt: string | null; reserveUsd: number; monthlyCapUsd: number | null; spendingVerified: boolean }, now = new Date()): BudgetConfig {
    if (!Number.isFinite(input.allowanceUsd) || input.allowanceUsd < 0 || input.allowanceUsd > 100000) throw new Error('Enter the credit amount shown in the Console.');
    if (!Number.isFinite(input.reserveUsd) || input.reserveUsd < 0) throw new Error('The reserve must be zero or more.');
    if (input.monthlyCapUsd !== null && (!Number.isFinite(input.monthlyCapUsd) || input.monthlyCapUsd < 0)) throw new Error('The monthly cap must be zero or more.');
    if (input.expiresAt !== null && Number.isNaN(Date.parse(input.expiresAt))) throw new Error('The expiry date is not a valid date.');
    const cfg: BudgetConfig = {
      allowanceUsd: input.allowanceUsd, allowanceVerifiedAt: now.toISOString(), expiresAt: input.expiresAt,
      reserveUsd: input.reserveUsd, monthlyCapUsd: input.monthlyCapUsd,
      spendingVerified: input.spendingVerified, providerBlocked: null,
    };
    setSetting(this.db, 'budget', cfg);
    return cfg;
  }

  setProviderBlocked(message: string): void {
    setSetting(this.db, 'budget', { ...this.config(), providerBlocked: message });
  }

  private sums(cfg: BudgetConfig, now: Date) {
    const since = cfg.allowanceVerifiedAt ?? '0000';
    const q = (where: string, from: string) =>
      (this.db.prepare(`SELECT COALESCE(SUM(${where}), 0) AS v FROM ledger WHERE created_at >= ?`).get(from) as { v: number }).v;
    const settled = q("CASE WHEN status = 'settled' THEN actual_usd ELSE 0 END", since);
    // Uncertain entries stay held at the full reservation (or the corrected figure) until resolved.
    const held = q("CASE WHEN status = 'reserved' THEN reserved_usd WHEN status = 'uncertain' THEN COALESCE(actual_usd, reserved_usd) ELSE 0 END", since);
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const month = q("CASE WHEN status = 'settled' THEN actual_usd WHEN status IN ('reserved','uncertain') THEN COALESCE(actual_usd, reserved_usd) ELSE 0 END", monthStart);
    return { settled: round(settled), held: round(held), month: round(month) };
  }

  status(now = new Date()): BudgetStatus {
    const cfg = this.config();
    const { settled, held, month } = this.sums(cfg, now);
    const remaining = cfg.allowanceUsd === null ? null : round(cfg.allowanceUsd - settled - held - cfg.reserveUsd);
    let state: BudgetState = 'ok';
    let message = 'Cloud requests are allowed.';
    if (!this.hasKey()) { state = 'no_key'; message = 'No API key is stored yet. Add one in Settings → Claude.'; }
    else if (cfg.providerBlocked) { state = 'provider_blocked'; message = `Anthropic reported that credit is unavailable (${cfg.providerBlocked}). Check the Console balance, then re-verify the budget. Nothing was purchased.`; }
    else if (!cfg.spendingVerified) { state = 'unverified'; message = 'The no-extra-spending checklist is not confirmed, so cloud requests are off. Finish it in Settings → Budget.'; }
    else if (cfg.allowanceUsd === null) { state = 'no_allowance'; message = 'Enter the included credit shown in the Claude Console to enable cloud requests.'; }
    else if (cfg.expiresAt && Date.parse(cfg.expiresAt) <= now.getTime()) { state = 'expired'; message = 'The recorded credit expiry has passed. Check the Console for this period’s credit and re-verify.'; }
    else if ((remaining ?? 0) <= 0 || (cfg.monthlyCapUsd !== null && month >= cfg.monthlyCapUsd)) { state = 'exhausted'; message = 'The app budget is used up (including the reserve and any held amounts). Local notes, the avatar, voice and YouTube stats still work.'; }
    return { state, message, allowanceUsd: cfg.allowanceUsd, settledUsd: settled, heldUsd: held, remainingUsd: remaining, monthUsd: month, expiresAt: cfg.expiresAt, verifiedAt: cfg.allowanceVerifiedAt };
  }

  /** Reserve the maximum a request could cost. Fails closed in every non-ok state. */
  reserve(req: { model: string; purpose: string; maxUsd: number }, now = new Date()): { ok: true; id: number } | { ok: false; state: BudgetState; message: string } {
    if (!Number.isFinite(req.maxUsd) || req.maxUsd <= 0) return { ok: false, state: 'unverified', message: 'The request cost could not be bounded, so it was not sent.' };
    return tx(this.db, () => {
      const st = this.status(now);
      if (st.state !== 'ok') return { ok: false as const, state: st.state, message: st.message };
      const cfg = this.config();
      const overAllowance = req.maxUsd > (st.remainingUsd ?? 0);
      const overMonth = cfg.monthlyCapUsd !== null && st.monthUsd + req.maxUsd > cfg.monthlyCapUsd;
      if (overAllowance || overMonth) {
        return { ok: false as const, state: 'exhausted' as const,
          message: `This request could cost up to $${req.maxUsd.toFixed(2)}, but only $${Math.max(0, st.remainingUsd ?? 0).toFixed(2)} of the app budget is free${overMonth ? ' (monthly cap reached)' : ''}. It was not sent.` };
      }
      const r = this.db.prepare("INSERT INTO ledger(created_at, model, purpose, reserved_usd, status) VALUES(?, ?, ?, ?, 'reserved')")
        .run(now.toISOString(), req.model, req.purpose, round(req.maxUsd));
      return { ok: true as const, id: Number(r.lastInsertRowid) };
    });
  }

  /** The API returned usage: replace the reservation with the computed cost. */
  settle(id: number, actualUsd: number, usage?: unknown): void {
    this.db.prepare("UPDATE ledger SET status = 'settled', actual_usd = ?, usage = ? WHERE id = ? AND status IN ('reserved','uncertain')")
      .run(round(Math.max(0, actualUsd)), usage ? JSON.stringify(usage) : null, id);
  }

  /** Only for requests the provider definitely did not bill (rejected before processing, or never sent). */
  release(id: number, note: string): void {
    this.db.prepare("UPDATE ledger SET status = 'released', actual_usd = 0, note = ? WHERE id = ? AND status = 'reserved'").run(note, id);
  }

  /** Cancelled, disconnected or failed mid-flight: the charge is unknown, so the full reservation stays held. */
  markUncertain(id: number, note: string): void {
    this.db.prepare("UPDATE ledger SET status = 'uncertain', note = ? WHERE id = ? AND status = 'reserved'").run(note, id);
  }

  /** Gavin resolves a held entry with the figure from the Console usage page, or keeps the full hold as spent. */
  resolveUncertain(id: number, actualUsd: number | null): void {
    const row = this.db.prepare("SELECT reserved_usd FROM ledger WHERE id = ? AND status = 'uncertain'").get(id) as { reserved_usd: number } | undefined;
    if (!row) throw new Error('That entry is not waiting to be resolved.');
    const actual = actualUsd === null ? row.reserved_usd : actualUsd;
    if (!Number.isFinite(actual) || actual < 0) throw new Error('Enter the charge shown in the Console.');
    this.db.prepare("UPDATE ledger SET status = 'settled', actual_usd = ?, note = COALESCE(note, '') || ' — resolved by Gavin' WHERE id = ?").run(round(actual), id);
  }

  ledger(limit = 100): LedgerEntry[] {
    const rows = this.db.prepare('SELECT * FROM ledger ORDER BY id DESC LIMIT ?').all(limit) as any[];
    return rows.map((r) => ({ id: r.id, createdAt: r.created_at, model: r.model, purpose: r.purpose, reservedUsd: r.reserved_usd, actualUsd: r.actual_usd, status: r.status, note: r.note }));
  }
}
