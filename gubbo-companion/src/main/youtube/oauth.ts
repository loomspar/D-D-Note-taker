// Google OAuth for an installed desktop app: system browser + loopback redirect + PKCE.
// Read-only scopes only. Tokens are handed to the caller for protected storage; nothing is logged.
import crypto from 'node:crypto';
import http from 'node:http';

export const SCOPES = ['https://www.googleapis.com/auth/youtube.readonly', 'https://www.googleapis.com/auth/yt-analytics.readonly'];

export interface OAuthClient { clientId: string; clientSecret: string }
export interface Tokens { refreshToken: string; accessToken: string; expiresAt: number; scope: string }

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export class OAuthError extends Error {
  constructor(message: string, public code: 'cancelled' | 'denied' | 'invalid_grant' | 'invalid_client' | 'network' | 'scope' | 'other') { super(message); }
}

async function tokenRequest(params: Record<string, string>, fetchFn: typeof fetch): Promise<any> {
  let res: Response;
  try {
    res = await fetchFn('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  } catch { throw new OAuthError('Could not reach Google. Check the internet connection.', 'network'); }
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (body.error === 'invalid_grant') throw new OAuthError('Google no longer accepts the saved sign-in. Projects left in “Testing” expire sign-ins after 7 days — reconnect YouTube.', 'invalid_grant');
    if (body.error === 'invalid_client') throw new OAuthError('Google rejected the client ID or secret. Re-enter them from the Google Cloud console.', 'invalid_client');
    throw new OAuthError(`Google sign-in failed (${body.error ?? res.status}).`, 'other');
  }
  return body;
}

/**
 * Opens the consent page in the default browser and waits for Google to redirect to a one-shot
 * listener on 127.0.0.1. Resolves with tokens, or rejects if the user closes the tab / times out.
 */
export function authorize(client: OAuthClient, openUrl: (url: string) => void, opts: { fetchFn?: typeof fetch; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Tokens> {
  const fetchFn = opts.fetchFn ?? fetch;
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err: Error | null, tokens?: Tokens) => {
      if (done) return; done = true;
      clearTimeout(timer); server.close();
      err ? reject(err) : resolve(tokens!);
    };
    const page = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><title>Gubbo Companion</title><body style="font:16px system-ui;background:#1b1a20;color:#eee;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2 style="color:#b48cff">${title}</h2><p>${body}</p></div>`;
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/oauth2callback') { res.writeHead(404).end(); return; }
      const send = (t: string, b: string) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page(t, b));
      if (url.searchParams.get('state') !== state) { send('Sign-in not completed', 'This request did not come from Gubbo Companion.'); return; }
      if (url.searchParams.get('error')) { send('Access not granted', 'You can close this tab and try again from the app.'); finish(new OAuthError('Access was not granted in the browser.', 'denied')); return; }
      const code = url.searchParams.get('code');
      if (!code) { send('Sign-in not completed', 'No authorization code was returned.'); return; }
      try {
        const redirect = `http://127.0.0.1:${(server.address() as any).port}/oauth2callback`;
        const body = await tokenRequest({ code, client_id: client.clientId, client_secret: client.clientSecret, redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: verifier }, fetchFn);
        const granted = String(body.scope ?? '');
        if (!SCOPES.every((s) => granted.split(' ').includes(s))) {
          send('More access needed', 'Both YouTube read-only boxes need to be ticked. Return to the app and connect again.');
          finish(new OAuthError('Both read-only permissions (YouTube and YouTube Analytics) must be ticked on the Google screen.', 'scope')); return;
        }
        if (!body.refresh_token) { send('Sign-in not completed', 'Google did not return a long-lived sign-in.'); finish(new OAuthError('Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and connect again.', 'other')); return; }
        send('YouTube connected', 'You can close this tab and return to Gubbo Companion.');
        finish(null, { refreshToken: body.refresh_token, accessToken: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000, scope: granted });
      } catch (e) { send('Sign-in failed', 'Return to the app for details.'); finish(e as Error); }
    });
    const timer = setTimeout(() => finish(new OAuthError('Sign-in was not finished within five minutes.', 'cancelled')), opts.timeoutMs ?? 300_000);
    opts.signal?.addEventListener('abort', () => finish(new OAuthError('Sign-in cancelled.', 'cancelled')));
    server.on('error', (e) => finish(e));
    server.listen(0, '127.0.0.1', () => {
      const redirect = `http://127.0.0.1:${(server.address() as any).port}/oauth2callback`;
      const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      u.search = new URLSearchParams({ client_id: client.clientId, redirect_uri: redirect, response_type: 'code', scope: SCOPES.join(' '), code_challenge: challenge, code_challenge_method: 'S256', state, access_type: 'offline', prompt: 'consent select_account' }).toString();
      openUrl(u.toString());
    });
  });
}

export async function refresh(client: OAuthClient, refreshToken: string, fetchFn: typeof fetch = fetch): Promise<{ accessToken: string; expiresAt: number }> {
  const body = await tokenRequest({ client_id: client.clientId, client_secret: client.clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }, fetchFn);
  return { accessToken: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
}

export async function revoke(token: string, fetchFn: typeof fetch = fetch): Promise<void> {
  try { await fetchFn('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) }); } catch { /* best effort */ }
}
