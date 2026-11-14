import { useEffect, useState } from 'react';
import type { Comparison, YtStatus } from '../../shared/types';
import { call, on } from '../bridge';
import { useApp } from './app';
import { Link, Row } from './sections';

const n = (v: number | null | undefined) => (v === null || v === undefined ? '—' : Math.round(v).toLocaleString());
const dur = (sec: number | null) => (sec === null ? '—' : `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`);
const day = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function Period({ label, c }: { label: string; c: Comparison | null }) {
  if (!c) return <div className="card"><h4>{label}</h4><p className="muted">No data returned yet.</p></div>;
  const cur = c.current;
  return (
    <div className="card">
      <h4>{label} <span className="muted">{day(cur.start)} – {day(cur.end)}{!cur.complete && ` · partial (${cur.days - cur.missingDays.length} of ${cur.days} days)`}</span></h4>
      <div className="stats">
        <div><b>{n(cur.views)}</b><span>views{c.viewsChangePct !== null && <em className={c.viewsChangePct >= 0 ? 'up' : 'down'}> {c.viewsChangePct >= 0 ? '+' : ''}{c.viewsChangePct}% vs previous {cur.days} days</em>}</span></div>
        <div><b>{n(cur.minutesWatched / 60)} h</b><span>watch time</span></div>
        <div><b>{dur(cur.avgViewDurationSec)}</b><span>average view duration</span></div>
        <div><b>{cur.netSubs >= 0 ? '+' : ''}{n(cur.netSubs)}</b><span>net subscribers (+{n(cur.subsGained)} / −{n(cur.subsLost)})</span></div>
      </div>
      {c.note && <p className="muted">{c.note}</p>}
    </div>
  );
}

export function ChannelScreen({ embedded = false }: { embedded?: boolean }) {
  const { toast, say, chat, setTab, speaker, settings, patch } = useApp();
  const [st, setSt] = useState<YtStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [client, setClient] = useState({ clientId: '', clientSecret: '' });
  const run = async (label: string, fn: () => Promise<YtStatus>) => { setBusy(label); try { setSt(await fn()); } catch (e) { toast((e as Error).message, 'error'); setSt(await call('yt:status')); } finally { setBusy(null); } };
  const brief = async () => { setBusy('brief'); try { const b = await call<{ ok: boolean; text: string }>('yt:briefing', 'briefing'); toast(b.text, b.ok ? 'ok' : 'warn'); setSt(await call('yt:status')); await say(b.text); } finally { setBusy(null); } };
  useEffect(() => { void call<YtStatus>('yt:status').then(setSt); return on('briefing:request', () => void brief()); }, []);
  if (!st) return null;

  if (!st.connected) {
    return (
      <div className={embedded ? '' : 'narrow'}>
        {!embedded && <h2>Connect your YouTube channel</h2>}
        <p className="muted">Gubbo only ever asks for <b>read-only</b> access: it can see your channel’s public details and analytics, and cannot post, edit or delete anything. Google requires each personal app to use its own free API project, so this is a one-time setup of about ten minutes. It costs nothing.</p>
        <ol className="steps">
          <li>Open the <Link href="https://console.cloud.google.com/projectcreate">Google Cloud console</Link>, signed in with the Google account that owns your channel, and create a project (any name, e.g. “Gubbo Companion”).</li>
          <li>Enable two APIs in that project: <Link href="https://console.cloud.google.com/apis/library/youtube.googleapis.com">YouTube Data API v3</Link> and <Link href="https://console.cloud.google.com/apis/library/youtubeanalytics.googleapis.com">YouTube Analytics API</Link>.</li>
          <li>Open <Link href="https://console.cloud.google.com/auth/overview">Google Auth Platform</Link> and set up the consent screen: audience <b>External</b>, then add your own Google address under <b>Test users</b>.</li>
          <li>Under <Link href="https://console.cloud.google.com/auth/clients">Clients</Link>, create an OAuth client of type <b>Desktop app</b>. Copy its client ID and client secret into the boxes below.</li>
        </ol>
        <p className="notice warn">While the Google project is in “Testing”, Google signs you out every 7 days and Gubbo will ask you to reconnect. To avoid that, press “Publish app” on the Audience page — for personal use with read-only access you can stay unverified and simply continue past Google’s warning screen.</p>
        <Row label="Client ID"><input className="grow" spellCheck={false} placeholder={st.configured ? 'Saved — paste to replace' : '…apps.googleusercontent.com'} value={client.clientId} onChange={(e) => setClient({ ...client, clientId: e.target.value })} /></Row>
        <Row label="Client secret"><input className="grow" type="password" autoComplete="off" placeholder={st.configured ? 'Saved — paste to replace' : ''} value={client.clientSecret} onChange={(e) => setClient({ ...client, clientSecret: e.target.value })} /></Row>
        <div className="inline">
          <button disabled={!client.clientId || !client.clientSecret} onClick={() => run('save', async () => { const r = await call<YtStatus>('yt:setClient', client); setClient({ clientId: '', clientSecret: '' }); toast('Saved with Windows protection.', 'ok'); return r; })}>Save</button>
          <button className="primary" disabled={!st.configured || busy !== null} onClick={() => run('connect', () => call('yt:connect'))}>{busy === 'connect' ? 'Waiting for you in the browser…' : 'Connect YouTube'}</button>
          {busy === 'connect' && <button onClick={() => call('yt:cancelConnect')}>Cancel</button>}
        </div>
        <p className="muted">On Google’s screen, choose the channel itself if it is a Brand Account, and tick both read-only boxes.</p>
        {st.error && <p className="notice bad">{st.error}</p>}
      </div>
    );
  }

  const r = st.report;
  if (!r) return <div className="narrow"><p className="notice bad">Connected, but no figures could be fetched{st.error ? `: ${st.error}` : '.'}</p><div className="inline"><button onClick={() => run('refresh', () => call('yt:refresh'))}>Try again</button><button onClick={() => run('disc', () => call('yt:disconnect', {}))}>Disconnect</button></div></div>;

  if (!st.channelConfirmed) {
    return (
      <div className="narrow">
        <h2>Is this your channel?</h2>
        <div className="card inline">{r.channel.thumbnail && <img src={r.channel.thumbnail} alt="" width={56} height={56} />}<div><h3>{r.channel.title}</h3><p className="muted">{r.channel.customUrl ?? r.channel.id} · {n(r.channel.videoCount)} videos</p></div></div>
        <div className="inline"><button className="primary" onClick={() => run('confirm', () => call('yt:confirmChannel', r.channel.id))}>Yes, that’s it</button><button onClick={() => run('disc', async () => { await call('yt:disconnect', {}); toast('Disconnected. Connect again and choose the other account or Brand Account on Google’s screen.', 'warn'); return call('yt:status'); })}>No — pick a different account</button></div>
      </div>
    );
  }
  if (embedded) return <p className="notice ok">Connected to <b>{r.channel.title}</b>. Manage it in the Channel tab.</p>;

  return (
    <div>
      <div className="inline spread">
        <div className="inline">{r.channel.thumbnail && <img src={r.channel.thumbnail} alt="" width={44} height={44} className="round" />}<div><h2>{r.channel.title}</h2><span className="muted">{r.channel.customUrl ?? ''}</span></div></div>
        <div className="inline wrap">
          <button className="primary" disabled={busy !== null} onClick={brief}>{busy === 'brief' ? 'Fetching…' : '🔊 Speak briefing'}</button>
          <button onClick={() => speaker.stop()}>Stop</button>
          <button disabled={busy !== null} onClick={() => run('refresh', () => call('yt:refresh'))}>{busy === 'refresh' ? 'Refreshing…' : 'Refresh'}</button>
          <button title="Sends these figures to Claude and uses your API credit" onClick={() => { setTab('chat'); chat.send('Explain these channel results: what changed, what probably drove it, and what is too uncertain to conclude.', { includeAnalytics: true, newConversation: true }); }}>Explain these results (uses Claude credit)</button>
        </div>
      </div>
      {(st.stale || st.error) && <p className="notice warn">{st.error ? `Couldn’t refresh: ${st.error} ` : ''}Showing saved figures from {new Date(r.fetchedAt).toLocaleString()}.</p>}
      <p className="muted">Fetched {new Date(r.fetchedAt).toLocaleString()}. {r.latestDataDate ? `Analytics are complete through ${day(r.latestDataDate)}; later days are still being processed by YouTube and are not counted as zero.` : ''}</p>
      <div className="cards">
        <div className="card"><h4>Subscribers</h4><div className="stats"><div><b>{r.channel.hiddenSubscriberCount ? 'hidden' : `≈ ${n(r.channel.subscriberCountRounded)}`}</b><span>YouTube rounds this down to three significant figures — it is not an exact count</span></div></div></div>
        <Period label="Last 7 days of data" c={r.last7} />
        <Period label="Last 28 days of data" c={r.last28} />
      </div>
      {r.warnings.map((w, i) => <p key={i} className="notice warn">{w}</p>)}
      <h3>Top videos, last 28 days of data</h3>
      {r.topVideos28.length ? (
        <table><thead><tr><th>Video</th><th>Views</th><th>Watch time</th><th>Avg view</th><th title="Subscribers gained from this video’s watch page. Channel-wide changes are counted separately and do not equal the sum of this column.">Subs from video</th></tr></thead>
          <tbody>{r.topVideos28.map((v) => <tr key={v.videoId}><td><a href={`https://www.youtube.com/watch?v=${v.videoId}`} onClick={(e) => { e.preventDefault(); void call('external:open', `https://www.youtube.com/watch?v=${v.videoId}`); }}>{v.title}</a></td><td>{n(v.views)}</td><td>{v.minutesWatched === null ? '—' : `${n(v.minutesWatched / 60)} h`}</td><td>{dur(v.avgViewDurationSec)}</td><td>{n(v.subsGainedFromVideo)}</td></tr>)}</tbody></table>
      ) : <p className="muted">No per-video data for this period.</p>}
      <h3>Recent uploads</h3>
      {r.recentUploads.length ? (
        <table><thead><tr><th>Video</th><th>Published</th><th>Views (all time)</th><th>Likes</th><th>Comments</th></tr></thead>
          <tbody>{r.recentUploads.map((v) => <tr key={v.videoId}><td>{v.title}</td><td>{v.publishedAt ? new Date(v.publishedAt).toLocaleDateString() : '—'}</td><td>{n(v.views)}</td><td>{n(v.likes)}</td><td>{n(v.comments)}</td></tr>)}</tbody></table>
      ) : <p className="muted">No uploads were returned.</p>}
      <p className="muted">Impressions, click-through rate and audience-retention curves are not available through these API reports, so they are left out rather than estimated. They are in YouTube Studio.</p>
      <label className="check"><input type="checkbox" checked={settings.youtube.launchBriefing} onChange={(e) => patch({ youtube: { launchBriefing: e.target.checked } })} /> Give me a spoken briefing each time Gubbo Companion starts (once per start)</label>
      <div className="inline"><button onClick={() => run('disc', () => call('yt:disconnect', {}))}>Disconnect YouTube</button><button onClick={() => run('disc', () => call('yt:disconnect', { forgetClient: true }))}>Disconnect and forget Google client</button></div>
    </div>
  );
}
