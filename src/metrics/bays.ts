/**
 * Per-bay alignment correction.
 *
 * `launchDirection` is reported relative to the line from the bay to the
 * SELECTED TARGET. When you aim somewhere other than that target — e.g. simply
 * hitting straight out of the bay — every shot picks up a constant offset equal
 * to the angle between your actual aim and that line.
 *
 * This is geometry, not radar error. Deriving the bay->target angle from
 * bayPosition/targetPosition and comparing it to the measured median gives
 * r = -0.99 across this account's eight (bay, target) combinations.
 *
 * Left uncorrected it manufactures a push that does not exist: an apparent
 * +12.7° mean launch direction on the 4-iron is almost entirely which bay it
 * was hit from, and changing bays mid-month reads as a sudden swing change.
 *
 * The offset is keyed on (bay, target), NOT bay alone — one bay can host
 * several targets. In this data BAY07's two targets differ by 11.8°, so
 * collapsing them to a single per-bay number is wrong for both.
 *
 * Curvature is unaffected — `curve` is measured off the launch line, so it was
 * already immune to this. Only direction and lateral position need correcting.
 */

import { MS_TO_MPH } from './units';
import type { RangeStroke, RangeStrokeMeasurement } from '../api/types';

/** Minimum shots before a bay's offset is trustworthy. */
const MIN_SHOTS_PER_BAY = 8;

function median(v: number[]): number | null {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface BayOffset {
  bay: string;
  /** Selected target. The offset is a property of the bay AND the target. */
  targetId: string | null;
  offsetDeg: number;
  n: number;
  /** IQR of launch direction within the group — how noisy the estimate is. */
  spreadDeg: number | null;
  /**
   * Angle from the bay's straight-ahead axis to the selected target, derived
   * from bayPosition/targetPosition. Independent confirmation that the offset
   * is geometry rather than radar error — the two correlate at r = -0.99.
   */
  geometricDeg: number | null;
}

/** Offsets are keyed on bay AND target: one bay can host several targets. */
export const offsetKey = (bay: string | null, targetId: string | null): string =>
  `${bay ?? '?'}|${targetId ?? '?'}`;

/**
 * Horizontal angle from the range axis (+x) to the bay->target line.
 *
 * Position arrays are [x, y, z] with y vertical. Bays sit in a row varying in
 * z; the range runs along +x.
 */
function geometricAngle(
  bayPosition: number[] | null,
  targetPosition: number[] | null,
): number | null {
  if (!bayPosition || !targetPosition) return null;
  if (bayPosition.length < 3 || targetPosition.length < 3) return null;
  const dx = targetPosition[0] - bayPosition[0];
  const dz = targetPosition[2] - bayPosition[2];
  if (dx === 0 && dz === 0) return null;
  return (Math.atan2(dz, dx) * 180) / Math.PI;
}

/**
 * Estimate each (bay, target) offset as the median launch direction of shots
 * hit from it.
 *
 * Computed over well-struck shots only: mishits scatter directionally and would
 * bias the estimate. Using the median rather than the geometric angle means the
 * correction stays right whatever you were actually aiming at — measured against
 * the pure straight-out-of-the-bay prediction, this player's shots regress with
 * slope 0.71, i.e. they aim about 29% of the way toward the selected target
 * without meaning to. The empirical median absorbs that; raw geometry would
 * over-correct by the same 29%.
 */
export function computeBayOffsets(
  strokes: RangeStroke[],
  isCleanStrike: (m: RangeStrokeMeasurement, club: string | null) => boolean,
): Map<string, BayOffset> {
  const groups = new Map<
    string,
    { bay: string; targetId: string | null; dirs: number[]; geo: number | null }
  >();

  for (const s of strokes) {
    const m = s.proBall ?? s.raw;
    if (!m || !s.bayName || m.launchDirection == null) continue;
    if (!isCleanStrike(m, s.club)) continue;
    const key = offsetKey(s.bayName, s.targetId);
    if (!groups.has(key)) {
      groups.set(key, {
        bay: s.bayName,
        targetId: s.targetId,
        dirs: [],
        geo: geometricAngle(s.bayPosition, s.targetPosition),
      });
    }
    groups.get(key)!.dirs.push(m.launchDirection);
  }

  const out = new Map<string, BayOffset>();
  for (const [key, g] of groups) {
    if (g.dirs.length < MIN_SHOTS_PER_BAY) continue;
    const sorted = [...g.dirs].sort((a, b) => a - b);
    const q1 = sorted[Math.floor(sorted.length * 0.25)];
    const q3 = sorted[Math.floor(sorted.length * 0.75)];
    out.set(key, {
      bay: g.bay,
      targetId: g.targetId,
      offsetDeg: median(g.dirs)!,
      n: g.dirs.length,
      spreadDeg: q3 - q1,
      geometricDeg: g.geo,
    });
  }
  return out;
}

/** Convenience predicate matching the clean-strike rule used elsewhere. */
export function makeCleanStrikePredicate(refSpeeds: Map<string, number>) {
  return (m: RangeStrokeMeasurement, club: string | null): boolean => {
    const ref = refSpeeds.get(club ?? '');
    const ball = m.ballSpeed == null ? null : m.ballSpeed * MS_TO_MPH;
    if (ball == null || ref == null) return false;
    if (ball < ref * 0.75) return false;
    if (m.launchAngle != null && m.launchAngle < 5) return false;
    return true;
  };
}

/**
 * Apply a bay offset to a shot's direction and lateral position.
 *
 * Rotates the shot about the tee by −offset: the start line and the finish
 * angle both shift, and the corrected side is recomputed at the same forward
 * distance. Carry itself is unchanged.
 */
export function applyBayOffset(
  m: RangeStrokeMeasurement,
  offsetDeg: number | undefined,
): { launchDirection: number | null; carrySide: number | null; corrected: boolean } {
  if (offsetDeg == null) {
    return { launchDirection: m.launchDirection, carrySide: m.carrySide, corrected: false };
  }

  const dir = m.launchDirection == null ? null : m.launchDirection - offsetDeg;

  let side = m.carrySide;
  if (m.carry != null && m.carrySide != null) {
    const forward = Math.sqrt(Math.max(0, m.carry ** 2 - m.carrySide ** 2));
    const finish = Math.atan2(m.carrySide, forward);
    side = forward * Math.tan(finish - (offsetDeg * Math.PI) / 180);
  }

  return { launchDirection: dir, carrySide: side, corrected: true };
}
