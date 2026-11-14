import { describe, expect, it } from 'vitest';
import type { ChannelReport } from '../src/shared/types';
import { openDb } from '../src/main/db';
import { addDays, compare, parseDayRows, periodTotals, type DayRow } from '../src/main/youtube/analytics';
import { answerSubscribers, detectIntent, narrate } from '../src/main/youtube/briefing';
import { YouTubeService } from '../src/main/youtube/service';

const row = (day: string, views: number, extra: Partial<DayRow> = {}): DayRow => ({ day, views, minutesWatched: views * 3, avgViewDurationSec: 180, subsGained: 2, subsLost: 1, ...extra });
const days = (end: string, n: number, views: (i: number) => number) => Array.from({ length: n }, (_, i) => row(addDays(end, -(n - 1 - i)), views(i)));

describe('analytics interpretation', () => {
  it('parses rows by column header, whatever the order', () => {
    const r = parseDayRows({ columnHeaders: [{ name: 'views' }, { name: 'day' }, { name: 'subscribersLost' }, { name: 'subscribersGained' }, { name: 'estimatedMinutesWatched' }, { name: 'averageViewDuration' }], rows: [[50, '2026-11-02', 1, 4, 120, 144], [40, '2026-11-01', 0, 2, 100, 150]] });
    expect(r.map((x) => x.day)).toEqual(['2026-11-01', '2026-11-02']);
    expect(r[1]).toMatchObject({ views: 50, subsGained: 4, subsLost: 1, minutesWatched: 120 });
    expect(() => parseDayRows({ columnHeaders: [{ name: 'foo' }], rows: [] })).toThrow();
  });

  it('compares equal-length complete periods ending at the latest processed day', () => {
    const rows = days('2026-11-10', 14, (i) => (i < 7 ? 100 : 150));     // API has nothing after Nov 10 yet
    const c = compare(rows, 7)!;
    expect(c.current).toMatchObject({ start: '2026-11-04', end: '2026-11-10', views: 1050, complete: true, netSubs: 7 });
    expect(c.previous).toMatchObject({ start: '2026-10-28', end: '2026-11-03', views: 700 });
    expect(c.viewsChangePct).toBe(50);
  });

  it('never treats a missing day as a zero-view day', () => {
    const rows = days('2026-11-10', 14, () => 100).filter((r) => r.day !== '2026-11-08');
    const c = compare(rows, 7)!;
    expect(c.current.complete).toBe(false);
    expect(c.current.missingDays).toEqual(['2026-11-08']);
    expect(c.current.views).toBe(600);
    expect(c.viewsChangePct).toBeNull();                                  // no percentage from a partial period
    expect(c.note).toMatch(/partial/);
    const genuineZero = compare(days('2026-11-10', 14, (i) => (i === 12 ? 0 : 100)), 7)!;
    expect(genuineZero.current.complete).toBe(true);                      // a real zero row is data
    expect(genuineZero.current.views).toBe(600);
  });

  it('avoids division by zero and incomplete comparison periods', () => {
    expect(compare(days('2026-11-10', 14, (i) => (i < 7 ? 0 : 10)), 7)!.viewsChangePct).toBeNull();
    const short = compare(days('2026-11-10', 9, () => 10), 7)!;
    expect(short.previous).toBeNull(); expect(short.viewsChangePct).toBeNull();
    expect(compare([], 7)).toBeNull();
  });

  it('weights average view duration by views and keeps gained and lost separate', () => {
    const t = periodTotals([row('2026-11-01', 100, { avgViewDurationSec: 60, subsGained: 10, subsLost: 12 }), row('2026-11-02', 300, { avgViewDurationSec: 180, subsGained: 0, subsLost: 0 })], '2026-11-02', 2);
    expect(t.avgViewDurationSec).toBe(150);
    expect(t).toMatchObject({ subsGained: 10, subsLost: 12, netSubs: -2 });
    expect(periodTotals([row('2026-11-01', 0)], '2026-11-01', 1).avgViewDurationSec).toBeNull();
  });
});

const report = (over: Partial<ChannelReport> = {}): ChannelReport => {
  const rows = days('2026-11-10', 60, (i) => (i < 53 ? 100 : 150));
  return { channel: { id: 'UC1', title: 'Gubbo', customUrl: '@gubbo', thumbnail: null, subscriberCountRounded: 12300, hiddenSubscriberCount: false, viewCount: 1, videoCount: 1, uploadsPlaylistId: 'UU1' }, fetchedAt: '2026-11-13T09:00:00Z', latestDataDate: '2026-11-10', last7: compare(rows, 7), last28: compare(rows, 28), topVideos28: [{ videoId: 'v1', title: 'I Survived 100 Days in One Chunk', publishedAt: null, views: 2400, minutesWatched: 9000, avgViewDurationSec: 225, subsGainedFromVideo: 11 }], recentUploads: [], warnings: [], ...over };
};

describe('spoken briefing', () => {
  it('is built only from fetched values and says the subscriber total is rounded', () => {
    const text = narrate(report());
    expect(text).toContain('briefing for Gubbo');
    expect(text).toContain('about 12,300 subscribers');
    expect(text).toContain('seven days ending November 10');
    expect(text).toContain('1,050 views');
    expect(text).toContain('up 50 percent');
    expect(text).toContain('I Survived 100 Days in One Chunk, with 2,400 views');
    expect(text).toContain('complete through November 10');
    expect(text).not.toMatch(/exactly|undefined|NaN|null/);
    expect(narrate(report())).toBe(text);                                 // deterministic
  });
  it('handles hidden counts, missing analytics and stale data without inventing numbers', () => {
    const r = report({ last7: null, last28: null, topVideos28: [], latestDataDate: null });
    r.channel.hiddenSubscriberCount = true; r.channel.subscriberCountRounded = null;
    const text = narrate(r, { stale: true });
    expect(text).toContain('hidden'); expect(text).toContain('saved figures from November 13'); expect(text).toContain('no view figures');
    expect(text).not.toMatch(/\d+ views/);
    expect(answerSubscribers(report(), true)).toMatch(/^From saved figures: You have about 12,300/);
  });
  it('recognises channel questions so they need no AI call', () => {
    for (const q of ['How is my channel doing?', 'Give me my channel briefing', "how's my channel", 'channel stats']) expect(detectIntent(q)).toBe('briefing');
    expect(detectIntent('How many subscribers do I have?')).toBe('subscribers');
    expect(detectIntent('Give me five long-form ideas for my channel')).toBeNull();
    expect(detectIntent('Compare my recent videos, then suggest what to test next.')).toBeNull();
  });
});

describe('youtube service', () => {
  const secrets = (token: string | null = 'rt') => { let t = token; return { getClient: () => ({ clientId: 'id', clientSecret: 's' }), getRefreshToken: () => t, clearTokens: () => { t = null; } }; };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const good = (calls: string[]) => (async (input: any) => {
    const url = String(input); calls.push(url);
    if (url.includes('oauth2.googleapis.com/token')) return json({ access_token: 'at', expires_in: 3600 });
    if (url.includes('/channels')) return json({ items: [{ id: 'UC1', snippet: { title: 'Gubbo' }, statistics: { subscriberCount: '12300', viewCount: '5', videoCount: '2' }, contentDetails: { relatedPlaylists: { uploads: 'UU1' } } }] });
    if (url.includes('dimensions=day')) return json({ columnHeaders: ['day', 'views', 'estimatedMinutesWatched', 'averageViewDuration', 'subscribersGained', 'subscribersLost'].map((name) => ({ name })), rows: days('2026-11-10', 60, () => 10).map((r) => [r.day, r.views, r.minutesWatched, r.avgViewDurationSec, r.subsGained, r.subsLost]) });
    if (url.includes('dimensions=video')) return json({ columnHeaders: ['video', 'views', 'estimatedMinutesWatched', 'averageViewDuration', 'subscribersGained'].map((name) => ({ name })), rows: [['v1', 99, 300, 180, 3]] });
    if (url.includes('/playlistItems')) return json({ items: [{ contentDetails: { videoId: 'v1' } }] });
    if (url.includes('/videos')) return json({ items: [{ id: 'v1', snippet: { title: 'Real Title', publishedAt: '2026-10-01T00:00:00Z' }, statistics: { viewCount: '500' }, contentDetails: { duration: 'PT12M' } }] });
    return json({}, 404);
  }) as typeof fetch;

  it('builds a report from real response shapes without using search', async () => {
    const calls: string[] = [];
    const yt = new YouTubeService(openDb(':memory:'), secrets(), () => 'UC1', good(calls));
    const st = await yt.refresh({ force: true });
    expect(st.error).toBeNull();
    expect(st.report!.channel.subscriberCountRounded).toBe(12300);
    expect(st.report!.latestDataDate).toBe('2026-11-10');
    expect(st.report!.topVideos28[0]).toMatchObject({ title: 'Real Title', views: 99 });
    expect(st.channelConfirmed).toBe(true);
    expect(calls.some((c) => c.includes('/youtube/v3/search'))).toBe(false);
    expect(calls.every((c) => !c.includes('youtube.force-ssl'))).toBe(true);
    const n = calls.length;
    await yt.refresh();                                                    // debounced: served from cache
    expect(calls.length).toBe(n);
  });

  it('shows cached figures as stale when a refresh fails, and nothing when there is no cache', async () => {
    const db = openDb(':memory:'); const calls: string[] = [];
    await new YouTubeService(db, secrets(), () => 'UC1', good(calls)).refresh({ force: true });
    const failing = new YouTubeService(db, secrets(), () => 'UC1', (async () => { throw new TypeError('fetch failed'); }) as typeof fetch);
    const st = await failing.refresh({ force: true });
    expect(st.error).toMatch(/Could not reach/); expect(st.stale).toBe(true); expect(st.report!.channel.title).toBe('Gubbo');
    const empty = await new YouTubeService(openDb(':memory:'), secrets(), () => null, (async () => { throw new TypeError('fetch failed'); }) as typeof fetch).refresh({ force: true });
    expect(empty.report).toBeNull(); expect(empty.error).toBeTruthy();
  });

  it('drops an expired sign-in and asks to reconnect', async () => {
    const sec = secrets();
    const yt = new YouTubeService(openDb(':memory:'), sec, () => null, (async () => json({ error: 'invalid_grant' }, 400)) as typeof fetch);
    const st = await yt.refresh({ force: true });
    expect(st.connected).toBe(false);
    expect(st.error).toMatch(/reconnect/i);
  });
});
