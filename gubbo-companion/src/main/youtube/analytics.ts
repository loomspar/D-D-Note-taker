// Pure interpretation of YouTube Analytics rows. No network, no Electron: unit-tested directly.
import type { Comparison, PeriodTotals } from '../../shared/types';

export interface DayRow { day: string; views: number; minutesWatched: number; avgViewDurationSec: number; subsGained: number; subsLost: number }

export const addDays = (isoDay: string, n: number): string => {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Parse a `dimensions=day` report using its own column headers, so column order never matters. */
export function parseDayRows(resp: { columnHeaders?: { name: string }[]; rows?: unknown[][] }): DayRow[] {
  const idx = (n: string) => (resp.columnHeaders ?? []).findIndex((h) => h.name === n);
  const cols = { day: idx('day'), views: idx('views'), min: idx('estimatedMinutesWatched'), avd: idx('averageViewDuration'), g: idx('subscribersGained'), l: idx('subscribersLost') };
  if (cols.day < 0 || cols.views < 0) throw new Error('The analytics response did not contain the expected day and views columns.');
  const num = (row: unknown[], i: number) => (i >= 0 && typeof row[i] === 'number' ? (row[i] as number) : 0);
  return (resp.rows ?? [])
    .filter((r) => typeof r[cols.day] === 'string')
    .map((r) => ({ day: r[cols.day] as string, views: num(r, cols.views), minutesWatched: num(r, cols.min), avgViewDurationSec: num(r, cols.avd), subsGained: num(r, cols.g), subsLost: num(r, cols.l) }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * Totals for the `days`-long window ending on `end` (inclusive). A day with no row is recorded as
 * missing — it is never counted as a zero-view day — and the period is flagged incomplete.
 */
export function periodTotals(rows: DayRow[], end: string, days: number): PeriodTotals {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const start = addDays(end, -(days - 1));
  const t: PeriodTotals = { start, end, days, complete: true, missingDays: [], views: 0, minutesWatched: 0, avgViewDurationSec: null, subsGained: 0, subsLost: 0, netSubs: 0 };
  let weighted = 0;
  for (let i = 0; i < days; i++) {
    const d = addDays(start, i);
    const r = byDay.get(d);
    if (!r) { t.missingDays.push(d); continue; }
    t.views += r.views; t.minutesWatched += r.minutesWatched; t.subsGained += r.subsGained; t.subsLost += r.subsLost;
    weighted += r.avgViewDurationSec * r.views;
  }
  t.complete = t.missingDays.length === 0;
  t.netSubs = t.subsGained - t.subsLost;
  // Average view duration over a period is the view-weighted mean, not the mean of daily averages.
  t.avgViewDurationSec = t.views > 0 ? Math.round(weighted / t.views) : null;
  return t;
}

/**
 * Compare the latest `days` of available data with the equal-length period before it. The window ends
 * at the most recent day the API returned, so unprocessed recent days are never treated as zeros.
 */
export function compare(rows: DayRow[], days: number): Comparison | null {
  if (!rows.length) return null;
  const latest = rows[rows.length - 1].day;
  const current = periodTotals(rows, latest, days);
  const prev = periodTotals(rows, addDays(latest, -days), days);
  let note: string | null = null;
  let previous: PeriodTotals | null = prev;
  let pct: number | null = null;
  if (!current.complete) note = `Only ${days - current.missingDays.length} of the last ${days} days have data, so this is a partial period.`;
  if (!prev.complete) { previous = null; note = (note ? note + ' ' : '') + 'There is not a full earlier period to compare against.'; }
  else if (!current.complete) { /* totals shown, but no percentage from a partial period */ }
  else if (prev.views === 0) note = 'The earlier period had no views, so a percentage change is not meaningful.';
  else pct = Math.round(((current.views - prev.views) / prev.views) * 1000) / 10;
  return { current, previous, viewsChangePct: pct, note };
}

export function latestDay(rows: DayRow[]): string | null { return rows.length ? rows[rows.length - 1].day : null; }
