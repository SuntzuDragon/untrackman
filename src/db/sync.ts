/**
 * Sync: pull range sessions and their strokes into IndexedDB.
 *
 * Incremental by default — sessions whose stroke count already matches what we
 * have stored are skipped, so the common case (one new session since last
 * visit) costs two requests rather than eight.
 */

import { fetchRangeActivities, fetchStrokes } from '../api/graphql';
import { db, type SessionRow, type StrokeRow } from './db';

export interface SyncProgress {
  phase: 'activities' | 'strokes' | 'done';
  sessionsSeen: number;
  sessionsTotal: number;
  sessionsFetched: number;
  strokesStored: number;
  currentLabel?: string;
}

export interface SyncResult {
  sessions: number;
  strokesStored: number;
  sessionsSkipped: number;
}

export async function sync(
  opts: { force?: boolean; onProgress?: (p: SyncProgress) => void } = {},
): Promise<SyncResult> {
  const { force = false, onProgress } = opts;
  const p: SyncProgress = {
    phase: 'activities',
    sessionsSeen: 0,
    sessionsTotal: 0,
    sessionsFetched: 0,
    strokesStored: 0,
  };
  const emit = () => onProgress?.({ ...p });

  const activities = await fetchRangeActivities((fetched, total) => {
    p.sessionsSeen = fetched;
    p.sessionsTotal = total;
    emit();
  });

  p.phase = 'strokes';
  p.sessionsTotal = activities.length;
  emit();

  let skipped = 0;

  for (const a of activities) {
    const existing = await db.sessions.get(a.id);
    const have = await db.strokes.where('sessionId').equals(a.id).count();

    // Skip only when we already hold every stroke the API says exists.
    const complete =
      !force &&
      existing?.syncedAt != null &&
      a.numberOfStrokes != null &&
      have >= a.numberOfStrokes;

    if (complete) {
      skipped += 1;
      p.sessionsFetched += 1;
      emit();
      continue;
    }

    p.currentLabel = new Date(a.time).toLocaleDateString();
    emit();

    const strokes = await fetchStrokes(a.id);

    const session: SessionRow = {
      id: a.id,
      time: a.time,
      location: a.location?.name ?? null,
      strokeCount: a.numberOfStrokes ?? strokes.length,
      isHidden: a.isHidden ?? false,
      syncedAt: Date.now(),
    };

    const rows: StrokeRow[] = strokes
      // Deleted strokes stay out of the store entirely.
      .filter((s) => !s.isDeleted)
      .map((s) => ({
        id: s.dbId,
        sessionId: a.id,
        time: s.time,
        club: s.club,
        raw: s,
      }));

    await db.transaction('rw', db.sessions, db.strokes, async () => {
      await db.sessions.put(session);
      // bulkPut keyed on dbId — re-running never duplicates.
      await db.strokes.bulkPut(rows);
    });

    p.strokesStored += rows.length;
    p.sessionsFetched += 1;
    emit();
  }

  p.phase = 'done';
  p.currentLabel = undefined;
  emit();

  return {
    sessions: activities.length,
    strokesStored: p.strokesStored,
    sessionsSkipped: skipped,
  };
}
