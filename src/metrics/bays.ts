/**
 * Per-bay alignment correction.
 *
 * `launchDirection` is reported relative to the line from the bay to the
 * SELECTED TARGET. When you aim somewhere other than that target — e.g. simply
 * hitting straight out of the bay — every shot picks up a constant offset equal
 * to the angle between your actual aim and that line.
 *
 * This is geometry, not radar error. Deriving the bay->target angle from
 * tee/bay and target positions and comparing it to the measured median gives
 * r = 0.99 across this account's eight (bay, target) combinations.
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
 *
 * WHAT THIS DELETES. The measured offset is the median start line of your own
 * clean strikes from that group, so subtracting it forces that median to
 * exactly 0° by construction. Any directional bias you hold across the whole
 * session — an open face, an aim that is not where you think it is — is
 * absorbed into the "bay offset" and cannot be recovered downstream. What
 * survives is each club's start line RELATIVE to your own average from that
 * bay. `residualDeg` exists so the absorbed part is at least reported rather
 * than silently discarded: it is how far your measured start line sits from
 * the straight-out-of-the-bay prediction that geometry alone gives.
 */

import { MS_TO_MPH } from './units';
import type { RangeStroke, RangeStrokeMeasurement } from '../api/types';

/**
 * Minimum shots before a group's offset is estimated from the shots themselves.
 * Below this we fall back to geometry, which needs no shots at all.
 */
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
  /**
   * Where `offsetDeg` came from. 'measured' is the median of your own strikes;
   * 'geometric' is predicted from the coordinates because the group was too
   * small to estimate from. Never silently mixed — the UI shows which.
   */
  source: 'measured' | 'geometric';
  n: number;
  /** IQR of launch direction within the group — how noisy the estimate is. */
  spreadDeg: number | null;
  /**
   * Standard error of the median, ~1.25·σ/√n estimated from the IQR. This is
   * the number that says whether the offset is pinned down; the raw IQR is
   * shot-to-shot dispersion and stays large no matter how many shots you hit.
   */
  stderrDeg: number | null;
  /**
   * Aim offset predicted from the tee and target coordinates alone, in the same
   * sign convention as `offsetDeg`: the launch direction a shot hit dead
   * straight out of the bay would be reported as. Independent confirmation that
   * the offset is geometry rather than radar error — the two correlate at
   * r = 0.99.
   */
  geometricDeg: number | null;
  /**
   * measured − geometric. How far your start line sits from straight out of the
   * bay: the directional bias the correction absorbs. Null when the offset came
   * from geometry (the residual would be 0 by definition).
   */
  residualDeg: number | null;
  /**
   * Distinct clubs contributing to a measured offset. One number is fitted
   * across all of them, so a group dominated by one club carries that club's
   * bias into every other club hit from the same bay. Low counts here mean
   * cross-bay centre comparisons are confounded.
   */
  clubs: number;
}

/** Offsets are keyed on bay AND target: one bay can host several targets. */
export const offsetKey = (bay: string | null, targetId: string | null): string =>
  `${bay ?? '?'}|${targetId ?? '?'}`;

/**
 * Aim offset predicted by geometry: the launch direction a shot hit straight
 * out of the bay would be reported as, given where the selected target sits.
 *
 * Position arrays are [x, y, z] with y vertical. Bays sit in a row varying in
 * z; the range runs along +x, and every bay is assumed to point down it — a
 * single point coordinate cannot tell us a bay's heading, so parallel bays is
 * an assumption. It is a well supported one: this matches the measured medians
 * at r = 0.99, which it could not do if bays were fanned.
 *
 * The negation is what puts this in `offsetDeg`'s convention (positive =
 * right). It is empirically calibrated: against raw atan2(dz, dx) the measured
 * medians correlate at −0.99, i.e. TrackMan's +z is left on the launch-
 * direction axis.
 *
 * Measured from the TEE rather than the bay centre where the tee is known —
 * the ball is struck from the tee, and the two differ by a few feet.
 */
function geometricOffset(
  origin: number[] | null,
  targetPosition: number[] | null,
): number | null {
  if (!origin || !targetPosition) return null;
  if (origin.length < 3 || targetPosition.length < 3) return null;
  const dx = targetPosition[0] - origin[0];
  const dz = targetPosition[2] - origin[2];
  if (dx === 0 && dz === 0) return null;
  return -(Math.atan2(dz, dx) * 180) / Math.PI;
}

/**
 * Estimate each (bay, target) offset.
 *
 * Preferred estimator is the median launch direction of shots hit from that
 * group, over well-struck shots only: mishits scatter directionally and would
 * bias it. Using the median rather than the geometric angle means the
 * correction stays right whatever you were actually aiming at.
 *
 * Groups with too few shots to estimate from fall back to the geometric angle
 * rather than going uncorrected. An uncorrected shot sitting in a corrected
 * plot is a ~60-yard outlier that drags the ellipse centre and inflates σ;
 * geometry is imperfect but it is far closer than no correction at all.
 */
export function computeBayOffsets(
  strokes: RangeStroke[],
  isCleanStrike: (m: RangeStrokeMeasurement, club: string | null) => boolean,
): Map<string, BayOffset> {
  const groups = new Map<
    string,
    {
      bay: string;
      targetId: string | null;
      dirs: number[];
      clubs: Set<string>;
      geo: number | null;
    }
  >();

  for (const s of strokes) {
    if (!s.bayName) continue;
    const key = offsetKey(s.bayName, s.targetId);
    if (!groups.has(key)) {
      groups.set(key, {
        bay: s.bayName,
        targetId: s.targetId,
        dirs: [],
        clubs: new Set(),
        geo: geometricOffset(s.teePosition ?? s.bayPosition, s.targetPosition),
      });
    }
    // Every stroke registers the group, so a group too small to measure still
    // gets its geometric fallback. Only clean strikes feed the median.
    const m = s.proBall ?? s.raw;
    if (!m || m.launchDirection == null) continue;
    if (!isCleanStrike(m, s.club)) continue;
    const g = groups.get(key)!;
    g.dirs.push(m.launchDirection);
    if (s.club) g.clubs.add(s.club);
  }

  const out = new Map<string, BayOffset>();
  for (const [key, g] of groups) {
    const n = g.dirs.length;
    const sorted = [...g.dirs].sort((a, b) => a - b);
    const iqr = n ? sorted[Math.floor(n * 0.75)] - sorted[Math.floor(n * 0.25)] : null;
    // IQR = 1.349σ for a normal, and the median's standard error is 1.253σ/√n.
    const stderr = iqr == null || !n ? null : (1.253 * (iqr / 1.349)) / Math.sqrt(n);

    const measured = n >= MIN_SHOTS_PER_BAY ? median(g.dirs) : null;
    const offsetDeg = measured ?? g.geo;
    if (offsetDeg == null) continue;

    out.set(key, {
      bay: g.bay,
      targetId: g.targetId,
      offsetDeg,
      source: measured == null ? 'geometric' : 'measured',
      n,
      spreadDeg: iqr,
      stderrDeg: measured == null ? null : stderr,
      geometricDeg: g.geo,
      residualDeg: measured != null && g.geo != null ? measured - g.geo : null,
      clubs: g.clubs.size,
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

/** Forward (down-range) component of a carry, metres. */
function forwardOf(m: RangeStrokeMeasurement): number | null {
  if (m.carry == null) return null;
  if (m.carrySide == null) return m.carry;
  return Math.sqrt(Math.max(0, m.carry ** 2 - m.carrySide ** 2));
}

/**
 * Apply a bay offset to a shot's direction and landing point.
 *
 * TrackMan's `carry` is the RADIAL distance to the landing point and
 * `carrySide` its lateral component — confirmed against the validation
 * fixture, where reconstructing curvature under the radial reading matches
 * native `curve` (+3.50 vs +3.33 m) and the forward reading does not (−0.04).
 *
 * Correcting is therefore a rotation of that landing point about the tee by
 * −offset, which leaves the radial distance alone and moves BOTH components:
 *
 *     side'    = carry · sin(finish − offset)
 *     forward' = carry · cos(finish − offset)
 *
 * An earlier version held `forward` fixed and took forward·tan(finish −
 * offset). That is not a rotation: it shrinks every corrected side by
 * cos(finish)/cos(finish − offset), ~6% at this range's 19° bays and less at
 * shallower ones — so it understated dispersion, and by a different factor per
 * bay, which made bays incomparable.
 *
 * Carry (radial) is unchanged, so nothing distance-related shifts.
 */
export function applyBayOffset(
  m: RangeStrokeMeasurement,
  offsetDeg: number | undefined,
): {
  launchDirection: number | null;
  carrySide: number | null;
  carryForward: number | null;
  corrected: boolean;
} {
  const forward = forwardOf(m);
  if (offsetDeg == null) {
    return {
      launchDirection: m.launchDirection,
      carrySide: m.carrySide,
      carryForward: forward,
      corrected: false,
    };
  }

  const dir = m.launchDirection == null ? null : m.launchDirection - offsetDeg;
  if (m.carry == null || m.carrySide == null || forward == null) {
    return { launchDirection: dir, carrySide: m.carrySide, carryForward: forward, corrected: true };
  }

  const theta = Math.atan2(m.carrySide, forward) - (offsetDeg * Math.PI) / 180;
  return {
    launchDirection: dir,
    carrySide: m.carry * Math.sin(theta),
    carryForward: m.carry * Math.cos(theta),
    corrected: true,
  };
}
