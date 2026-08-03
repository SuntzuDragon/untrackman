/**
 * OAuth2 device authorization grant against login.trackmangolf.com.
 *
 * Why the device grant and not authorization-code + PKCE: we cannot register a
 * redirect URI with Trackman's IdP, so the code flow is unavailable to us. The
 * device grant needs no redirect URI at all. Validated end to end in Phase 0
 * from an origin Trackman has never seen.
 *
 * Both auth endpoints send `access-control-allow-origin: *`, so this runs
 * entirely in the browser with no proxy.
 */

import type { DeviceCodeResponse, TokenSet } from './types';

const AUTH = 'https://login.trackmangolf.com';

/**
 * The portal's own client (`golf-portal.*`) rejects the device grant with
 * invalid_client. The legacy range app permits it. Public client, no secret.
 */
const CLIENT_ID = 'old-golf-app.c686e909-5102-45ac-9860-8d0b789073ae';

/**
 * `dr/cloud` is the scope the GraphQL API actually checks; `offline_access`
 * buys the refresh token that keeps you from ever seeing a login screen again.
 */
const SCOPES = [
  'openid',
  'profile',
  'offline_access',
  'https://auth.trackman.com/dr/cloud',
].join(' ');

const STORAGE_KEY = 'untrackman.tokens';

export class AuthError extends Error {}

/** Device code expired before the user approved it — mint a new one. */
export class DeviceCodeExpired extends AuthError {}

async function postForm(path: string, body: Record<string, string>) {
  const res = await fetch(`${AUTH}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json } as { status: number; json: any };
}

// ---------------------------------------------------------------------------
// token persistence
// ---------------------------------------------------------------------------

export function loadTokens(): TokenSet | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as TokenSet) : null;
  } catch {
    return null;
  }
}

export function saveTokens(t: TokenSet): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(t));
}

export function clearTokens(): void {
  localStorage.removeItem(STORAGE_KEY);
}

function toTokenSet(json: any): TokenSet {
  if (!json?.access_token) throw new AuthError(`No access_token: ${JSON.stringify(json)}`);
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    id_token: json.id_token,
    token_type: json.token_type,
    scope: json.scope,
    // Refresh a minute early so a request never races the expiry.
    expires_at: Date.now() + (json.expires_in ?? 3600) * 1000 - 60_000,
  };
}

// ---------------------------------------------------------------------------
// device flow
// ---------------------------------------------------------------------------

export async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const { status, json } = await postForm('/connect/deviceauthorization', {
    client_id: CLIENT_ID,
    scope: SCOPES,
  });
  if (!json?.device_code) {
    throw new AuthError(`Device authorization failed [${status}]: ${json?.error ?? 'unknown'}`);
  }
  return json as DeviceCodeResponse;
}

/**
 * Poll the token endpoint until the user approves, the code expires, or
 * `signal` aborts. Honours the spec's `slow_down` backoff.
 */
export async function pollForToken(
  dev: DeviceCodeResponse,
  opts: { signal?: AbortSignal; onTick?: (secondsLeft: number) => void } = {},
): Promise<TokenSet> {
  let interval = (dev.interval || 5) * 1000;
  const deadline = Date.now() + dev.expires_in * 1000;

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new AuthError('cancelled');
    await new Promise((r) => setTimeout(r, interval));
    opts.onTick?.(Math.max(0, Math.round((deadline - Date.now()) / 1000)));

    const { json } = await postForm('/connect/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: dev.device_code,
      client_id: CLIENT_ID,
    });

    const err = json?.error as string | undefined;
    if (err === 'authorization_pending') continue;
    if (err === 'slow_down') {
      interval += 5000;
      continue;
    }
    if (err === 'expired_token') throw new DeviceCodeExpired('Device code expired');
    if (err) throw new AuthError(`Token error: ${err}`);

    const tokens = toTokenSet(json);
    saveTokens(tokens);
    return tokens;
  }
  throw new DeviceCodeExpired('Device code expired');
}

export async function refreshTokens(refresh_token: string): Promise<TokenSet> {
  const { json } = await postForm('/connect/token', {
    grant_type: 'refresh_token',
    refresh_token,
    client_id: CLIENT_ID,
  });
  if (json?.error) throw new AuthError(`Refresh failed: ${json.error}`);
  const next = toTokenSet(json);
  // Trackman may not reissue a refresh token; keep the old one if so.
  if (!next.refresh_token) next.refresh_token = refresh_token;
  saveTokens(next);
  return next;
}

/**
 * Return a usable access token, refreshing if it has expired. Throws if there
 * is no stored session or the refresh fails — caller should start a device flow.
 */
export async function getValidToken(): Promise<string> {
  const t = loadTokens();
  if (!t) throw new AuthError('No stored session');
  if (Date.now() < t.expires_at) return t.access_token;
  if (!t.refresh_token) throw new AuthError('Session expired and no refresh token');
  const next = await refreshTokens(t.refresh_token);
  return next.access_token;
}
