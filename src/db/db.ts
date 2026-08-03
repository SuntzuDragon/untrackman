/**
 * Local persistence — IndexedDB via Dexie.
 *
 * There is no server and no database. 412 shots is a few hundred KB; this
 * scales to years of range sessions without trouble.
 *
 * Idempotency: strokes are keyed on the API's own `dbId` (a UUID), so a
 * re-sync overwrites rather than duplicates.
 */

import Dexie, { type EntityTable } from 'dexie';
import type { RangeStroke } from '../api/types';

export interface SessionRow {
  id: string;
  time: string;
  location: string | null;
  strokeCount: number | null;
  /** When we last pulled strokes for this session. */
  syncedAt: number | null;
}

export interface StrokeRow {
  /** RangeStroke.dbId — the API's UUID. Primary key, so sync is idempotent. */
  id: string;
  sessionId: string;
  time: string;
  club: string | null;
  /** The full stroke payload, both measurement variants, verbatim. */
  raw: RangeStroke;
}

const db = new Dexie('untrackman') as Dexie & {
  sessions: EntityTable<SessionRow, 'id'>;
  strokes: EntityTable<StrokeRow, 'id'>;
};

db.version(1).stores({
  sessions: 'id, time',
  strokes: 'id, sessionId, time, club',
});

export { db };

export async function clearAll(): Promise<void> {
  await db.transaction('rw', db.sessions, db.strokes, async () => {
    await db.sessions.clear();
    await db.strokes.clear();
  });
}

/** Everything needed to rebuild the analysis views. */
export async function allStrokes(): Promise<StrokeRow[]> {
  return db.strokes.toArray();
}

export async function allSessions(): Promise<SessionRow[]> {
  return db.sessions.orderBy('time').toArray();
}
