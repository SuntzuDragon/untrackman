/**
 * GraphQL transport.
 *
 * Runs directly from the browser: api.trackmangolf.com reflects any Origin in
 * access-control-allow-origin, so no proxy or backend is involved.
 *
 * This is an unofficial private API for personal use. Requests are serialised
 * and paced — do not remove the throttle.
 */

import { getValidToken, clearTokens, AuthError } from './auth';
import { ACTIVITIES, STROKES, PROFILE } from './queries';
import type { RangeActivity, RangeStroke } from './types';

const ENDPOINT = 'https://api.trackmangolf.com/graphql';

/** Minimum gap between requests. Be a good citizen. */
const MIN_INTERVAL_MS = 350;

let chain: Promise<unknown> = Promise.resolve();
let lastCall = 0;

export class GraphQLError extends Error {
  constructor(message: string, readonly errors?: unknown[]) {
    super(message);
  }
}

/** Serialise all requests through one chain and space them out. */
function throttle<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastCall);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    return fn();
  });
  // Keep the chain alive even if this link rejects.
  chain = run.catch(() => undefined);
  return run as Promise<T>;
}

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  return throttle(async () => {
    const token = await getValidToken();
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });

    if (res.status === 401) {
      clearTokens();
      throw new AuthError('Session rejected — sign in again');
    }
    if (!res.ok) {
      throw new GraphQLError(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }

    const body = await res.json();
    if (body.errors?.length) {
      throw new GraphQLError(
        body.errors.map((e: any) => e.message).join('; '),
        body.errors,
      );
    }
    return body.data as T;
  });
}

export async function fetchProfile(): Promise<{ id: string; fullName: string; email: string }> {
  const d = await gql<any>(PROFILE);
  return d.me.profile;
}

/** Every RANGE_PRACTICE session, paginated. */
export async function fetchRangeActivities(
  onProgress?: (fetched: number, total: number) => void,
): Promise<RangeActivity[]> {
  const out: RangeActivity[] = [];
  const take = 50;
  let skip = 0;
  let total = Infinity;

  while (skip < total) {
    const d = await gql<any>(ACTIVITIES, { take, skip });
    const conn = d.me.activities;
    total = conn.totalCount;
    const items = (conn.items ?? []).filter(
      (i: any) => i.__typename === 'RangePracticeActivity',
    );
    out.push(...items);
    onProgress?.(out.length, total);
    if (!conn.pageInfo?.hasNextPage || items.length === 0) break;
    skip += take;
  }
  return out;
}

export async function fetchStrokes(activityId: string): Promise<RangeStroke[]> {
  const d = await gql<any>(STROKES, { id: activityId });
  return (d.node?.strokes ?? []) as RangeStroke[];
}
