// Read-only YouTube Data + Analytics client with caching. Never fabricates: a failed call yields an
// error plus the last cached report (flagged stale), or nothing.
import type { ChannelReport, YtChannel, YtStatus, YtVideoRow } from '../../shared/types';
import { type DB, nowIso } from '../db';
import { addDays, compare, latestDay, parseDayRows } from './analytics';
import { type OAuthClient, OAuthError, refresh } from './oauth';

export interface YtSecrets {
  getClient(): OAuthClient | null;
  getRefreshToken(): string | null;
  clearTokens(): void;
}

const STALE_MS = 6 * 3600_000;
const DEBOUNCE_MS = 5 * 60_000;

export class YouTubeService {
  private access: { token: string; expiresAt: number } | null = null;
  private inflight: Promise<YtStatus> | null = null;
  private lastError: string | null = null;
  private backoffUntil = 0;
  private failures = 0;

  constructor(private db: DB, private secrets: YtSecrets, private confirmedChannelId: () => string | null, private fetchFn: typeof fetch = fetch) {}

  disconnectLocal(): void { this.access = null; this.lastError = null; this.db.prepare("DELETE FROM yt_cache").run(); }

  private cached(): { report: ChannelReport; fetchedAt: string } | null {
    const r = this.db.prepare("SELECT fetched_at, payload FROM yt_cache WHERE key = 'report'").get() as { fetched_at: string; payload: string } | undefined;
    if (!r) return null;
    try { return { report: JSON.parse(r.payload), fetchedAt: r.fetched_at }; } catch { return null; }
  }

  status(): YtStatus {
    const c = this.cached();
    const connected = !!this.secrets.getRefreshToken();
    return {
      configured: !!this.secrets.getClient(), connected,
      channelConfirmed: !!c && this.confirmedChannelId() === c.report.channel.id,
      report: connected ? c?.report ?? null : null,
      stale: !!c && Date.now() - Date.parse(c.fetchedAt) > STALE_MS,
      error: this.lastError,
    };
  }

  private async token(): Promise<string> {
    const client = this.secrets.getClient(), rt = this.secrets.getRefreshToken();
    if (!client || !rt) throw new Error('YouTube is not connected.');
    if (this.access && this.access.expiresAt - 60_000 > Date.now()) return this.access.token;
    try {
      const t = await refresh(client, rt, this.fetchFn);
      this.access = { token: t.accessToken, expiresAt: t.expiresAt };
      return t.accessToken;
    } catch (e) {
      if (e instanceof OAuthError && e.code === 'invalid_grant') this.secrets.clearTokens();
      throw e;
    }
  }

  private async get(url: string, params: Record<string, string>): Promise<any> {
    const u = new URL(url); u.search = new URLSearchParams(params).toString();
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try { res = await this.fetchFn(u, { headers: { authorization: `Bearer ${await this.token()}` } }); }
      catch (e) { if (e instanceof OAuthError) throw e; throw new Error('Could not reach YouTube. Check the internet connection.'); }
      if (res.status === 401 && attempt === 0) { this.access = null; continue; }
      const body: any = await res.json().catch(() => ({}));
      if (res.ok) return body;
      const reason = body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? '';
      if (res.status === 403 && /quota/i.test(reason)) throw new Error('The YouTube API quota for today is used up. Figures will refresh tomorrow.');
      if (res.status === 403) throw new Error(`YouTube refused the request (${reason || 'forbidden'}). Check that both the YouTube Data API v3 and YouTube Analytics API are enabled in the Google Cloud project.`);
      if ((res.status === 429 || res.status >= 500) && attempt < 2) { await new Promise((r) => setTimeout(r, 800 * 2 ** attempt)); continue; }
      throw new Error(`YouTube returned an error (${res.status}${reason ? ` ${reason}` : ''}).`);
    }
  }

  /** The channel the signed-in Google identity (personal or Brand Account) actually selected. */
  async fetchChannel(): Promise<YtChannel> {
    const body = await this.get('https://www.googleapis.com/youtube/v3/channels', { part: 'snippet,statistics,contentDetails', mine: 'true' });
    const it = body.items?.[0];
    if (!it) throw new Error('The Google account that was chosen has no YouTube channel. If the channel is a Brand Account, reconnect and pick the channel itself on Google’s “Choose an account” screen.');
    const s = it.statistics ?? {};
    const n = (v: unknown) => (v === undefined || v === null ? null : Number(v));
    return {
      id: it.id, title: it.snippet?.title ?? '(untitled channel)', customUrl: it.snippet?.customUrl ?? null,
      thumbnail: it.snippet?.thumbnails?.default?.url ?? null,
      hiddenSubscriberCount: !!s.hiddenSubscriberCount,
      subscriberCountRounded: s.hiddenSubscriberCount ? null : n(s.subscriberCount),
      viewCount: n(s.viewCount), videoCount: n(s.videoCount),
      uploadsPlaylistId: it.contentDetails?.relatedPlaylists?.uploads ?? null,
    };
  }

  private async buildReport(today: string): Promise<ChannelReport> {
    const warnings: string[] = [];
    const channel = await this.fetchChannel();
    const analytics = 'https://youtubeanalytics.googleapis.com/v2/reports';
    // 70 days back covers two full 28-day windows even when processing lags by several days.
    const start = addDays(today, -70);
    const dayResp = await this.get(analytics, { ids: 'channel==MINE', startDate: start, endDate: today, metrics: 'views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost', dimensions: 'day', sort: 'day' });
    const days = parseDayRows(dayResp);
    const latest = latestDay(days);

    let topVideos28: YtVideoRow[] = [];
    if (latest) {
      try {
        const top = await this.get(analytics, { ids: 'channel==MINE', startDate: addDays(latest, -27), endDate: latest, metrics: 'views,estimatedMinutesWatched,averageViewDuration,subscribersGained', dimensions: 'video', sort: '-views', maxResults: '10' });
        const h = (name: string) => (top.columnHeaders ?? []).findIndex((c: any) => c.name === name);
        const [iv, iw, im, ia, ig] = [h('video'), h('views'), h('estimatedMinutesWatched'), h('averageViewDuration'), h('subscribersGained')];
        topVideos28 = (top.rows ?? []).map((r: any[]) => ({ videoId: String(r[iv]), title: String(r[iv]), publishedAt: null, views: Number(r[iw] ?? 0), minutesWatched: im >= 0 ? Number(r[im]) : null, avgViewDurationSec: ia >= 0 ? Number(r[ia]) : null, subsGainedFromVideo: ig >= 0 ? Number(r[ig]) : null }));
      } catch (e) { warnings.push(`Top videos are unavailable: ${(e as Error).message}`); }
    } else warnings.push('YouTube Analytics returned no daily rows yet. New channels and brand-new connections can take a day or two.');

    // Recent uploads come from the uploads playlist (1 quota unit), never from search (100 units).
    let recent: ChannelReport['recentUploads'] = [];
    const titles = new Map<string, { title: string; publishedAt: string | null }>();
    try {
      let ids: string[] = [];
      if (channel.uploadsPlaylistId) {
        const pl = await this.get('https://www.googleapis.com/youtube/v3/playlistItems', { part: 'contentDetails', playlistId: channel.uploadsPlaylistId, maxResults: '10' });
        ids = (pl.items ?? []).map((i: any) => i.contentDetails?.videoId).filter(Boolean);
      }
      const all = [...new Set([...ids, ...topVideos28.map((v) => v.videoId)])].slice(0, 50);
      if (all.length) {
        const vids = await this.get('https://www.googleapis.com/youtube/v3/videos', { part: 'snippet,statistics,contentDetails', id: all.join(',') });
        const byId = new Map<string, any>((vids.items ?? []).map((v: any) => [v.id, v]));
        for (const [id, v] of byId) titles.set(id, { title: v.snippet?.title ?? id, publishedAt: v.snippet?.publishedAt ?? null });
        const n = (x: unknown) => (x === undefined || x === null ? null : Number(x));
        recent = ids.filter((id) => byId.has(id)).map((id) => { const v = byId.get(id); return { videoId: id, title: v.snippet?.title ?? id, publishedAt: v.snippet?.publishedAt ?? '', views: n(v.statistics?.viewCount), likes: n(v.statistics?.likeCount), comments: n(v.statistics?.commentCount), duration: v.contentDetails?.duration ?? null }; });
      }
    } catch (e) { warnings.push(`Recent uploads are unavailable: ${(e as Error).message}`); }
    topVideos28 = topVideos28.map((v) => ({ ...v, title: titles.get(v.videoId)?.title ?? '(title unavailable)', publishedAt: titles.get(v.videoId)?.publishedAt ?? null }));

    return { channel, fetchedAt: nowIso(), latestDataDate: latest, last7: compare(days, 7), last28: compare(days, 28), topVideos28, recentUploads: recent, warnings };
  }

  /**
   * Refresh on launch or on request. Concurrent callers share one fetch; repeated requests inside five
   * minutes reuse the cache unless forced; failures back off instead of hammering the API.
   */
  refresh(opts: { force?: boolean } = {}): Promise<YtStatus> {
    if (this.inflight) return this.inflight;
    const c = this.cached();
    if (!opts.force && c && Date.now() - Date.parse(c.fetchedAt) < DEBOUNCE_MS) return Promise.resolve(this.status());
    if (!opts.force && Date.now() < this.backoffUntil) return Promise.resolve(this.status());
    this.inflight = (async () => {
      try {
        const report = await this.buildReport(new Date().toISOString().slice(0, 10));
        this.db.prepare("INSERT INTO yt_cache(key, fetched_at, payload) VALUES('report', ?, ?) ON CONFLICT(key) DO UPDATE SET fetched_at = excluded.fetched_at, payload = excluded.payload").run(report.fetchedAt, JSON.stringify(report));
        this.lastError = null; this.failures = 0;
      } catch (e) {
        this.lastError = (e as Error).message;
        this.failures++;
        this.backoffUntil = Date.now() + Math.min(30 * 60_000, 30_000 * 2 ** (this.failures - 1));
      } finally { this.inflight = null; }
      const st = this.status();
      // After a failed refresh whatever is cached is, by definition, not current.
      return this.lastError ? { ...st, stale: !!st.report } : st;
    })();
    return this.inflight;
  }
}
