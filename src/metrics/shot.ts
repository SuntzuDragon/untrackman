/**
 * Derived per-shot metrics.
 *
 * Everything here operates on the PRO_BALL_MEASUREMENT view, which is what the
 * TrackMan phone app displays (validated in Phase 0 against two known shots).
 */

import { clubConfig } from './clubs';
import { M_TO_FT, M_TO_YD, MS_TO_MPH } from './units';
import { applyBayOffset, offsetKey, type BayOffset } from './bays';
import { carryEfficiency, type CarryModel } from './ballistics';
import type { RangeStroke, RangeStrokeMeasurement } from '../api/types';

/**
 * Fields the PRO_BALL_MEASUREMENT variant leaves null but SITE_MEASUREMENT
 * populates. Verified across all 412 strokes: landingAngle, ballSpinEffective
 * and reducedAccuracy are 0/412 on pro-ball and 412/412 on site.
 *
 * Preferring the pro-ball object wholesale therefore silently drops them — so
 * we merge per field rather than per object.
 */
const FALLBACK_FIELDS = [
  'landingAngle',
  'ballSpinEffective',
  'reducedAccuracy',
] as const satisfies readonly (keyof RangeStrokeMeasurement)[];

/**
 * Pro-ball values where present, site values for the fields pro-ball omits.
 *
 * Only the fields listed above are back-filled. Everything else stays strictly
 * pro-ball so the normalization basis of the numbers stays consistent — the
 * back-filled fields are geometry and flags, not normalized measurements.
 */
export function mergeMeasurement(
  proBall: RangeStrokeMeasurement | null,
  raw: RangeStrokeMeasurement | null,
): RangeStrokeMeasurement | null {
  if (!proBall) return raw;
  if (!raw) return proBall;
  const merged = { ...proBall };
  for (const f of FALLBACK_FIELDS) {
    if (merged[f] == null && raw[f] != null) {
      (merged as Record<string, unknown>)[f] = raw[f];
    }
  }
  return merged;
}

export type ShotQuality = 'good' | 'mishit' | 'unknown';

export interface Shot {
  id: string;
  sessionId: string;
  /** Timestamp of this stroke. Distinct from sessionTime — needed for fatigue. */
  time: string;
  /** Start of the session this belongs to. Use for grouping and trends. */
  sessionTime: string;
  /** 1-based position of this shot within its session, ordered by time. */
  shotIndex: number;
  club: string | null;
  bayName: string | null;

  // --- as displayed by the app, imperial ---
  carryYd: number | null;
  totalYd: number | null;
  carrySideFt: number | null;
  ballMph: number | null;
  spinRpm: number | null;
  spinAxis: number | null;
  launchAngle: number | null;
  /** As reported — still carries the bay's aim offset. */
  launchDirection: number | null;
  landingAngle: number | null;
  peakFt: number | null;

  // --- bay-corrected ---
  /** Launch direction with this bay's aim offset removed. Positive = right. */
  launchDirectionAdj: number | null;
  /** Carry side with the bay's aim offset removed, feet. Positive = right. */
  carrySideAdjFt: number | null;
  bayOffsetDeg: number | null;
  /** Absolute offline distance after correction, feet. */
  offlineFt: number | null;

  // --- derived ---
  /**
   * Signed curvature in FEET off the launch line. Positive = curved right
   * (fade/slice), negative = curved left (draw/hook).
   */
  curveFt: number | null;
  /**
   * Same thing as an angle, in degrees, for comparison across distances.
   * Positive = right.
   */
  curveDeg: number | null;
  /** ESTIMATED club speed (mph) from ball speed / assumed smash. Not measured. */
  estClubMph: number | null;
  /**
   * launchAngle − static loft.
   *
   * ALWAYS strongly negative for irons — a normal strike launches 10–20° below
   * static loft, because launch tracks dynamic loft (which shaft lean reduces)
   * rather than the loft stamped on the sole. On its own this number says
   * nothing about whether you are adding or removing loft; use loftDeltaVsOwn.
   */
  loftDelta: number | null;
  /**
   * loftDelta relative to this club's own median across your clean strikes.
   * Positive = launched higher than you normally do with this club. This is the
   * comparison that actually carries information.
   */
  loftDeltaVsOwn: number | null;

  /** Carry the launch conditions should have produced, yards. */
  expectedCarryYd: number | null;
  /**
   * Actual carry over expected. ~1.0 is normal; well under 1 means the ball had
   * the speed and angle of a good shot but did not fly like one.
   */
  carryEfficiency: number | null;

  quality: ShotQuality;
  qualityReason: string | null;

  /** True when this row came from the raw range-ball view instead of pro-ball. */
  isRawBall: boolean;
  accuracyFlags: string[];
}

/**
 * Curvature off the launch line.
 *
 * Trackman already computes this: the `curve` field is signed lateral
 * deviation from the launch line in metres, positive right. Verified in
 * Phase 0 — a 6-iron launched 10.92° over 144.9 m carry has a launch-line
 * lateral of 27.94 m against an actual carry side of 3.5 m, i.e. −24.44 m,
 * and the API reported curve = −24.14.
 *
 * Because it is measured off the LAUNCH line rather than the target line it is
 * already independent of how the bay is aimed, which was the whole point of
 * deriving one by hand.
 *
 * NOTE ON SIGN: the originally specified formula, launchDirection −
 * finishAngle, returns POSITIVE for a DRAW — the opposite of its stated
 * meaning. The 6-iron above started 10.92° right and finished 1.39° right,
 * i.e. it moved left, yet that formula yields +9.53. Native `curve` (−24.1)
 * and `spinAxis` (−19.65, left tilt) both agree it is a draw. Correlation
 * between the hand formula and native curve across 232 shots is −0.968.
 * We use native curve, with right positive.
 */
export function curvature(m: RangeStrokeMeasurement): {
  ft: number | null;
  deg: number | null;
} {
  if (m.curve == null) return { ft: null, deg: null };
  const ft = m.curve * M_TO_FT;

  // Angular equivalent: how far off the launch line, as an angle subtended at
  // the forward distance travelled.
  let deg: number | null = null;
  if (m.carry != null && m.carrySide != null) {
    const forward = Math.sqrt(Math.max(0, m.carry ** 2 - m.carrySide ** 2));
    if (forward > 1) deg = (Math.atan2(m.curve, forward) * 180) / Math.PI;
  }
  return { ft, deg };
}

/**
 * Classify contact quality.
 *
 * These are real mishits, not tracking errors — the user confirmed it, and the
 * data agrees: sub-50-yard 6-irons average 61.5 mph ball speed against 101.6
 * for the good ones, launching 0–4°. So we flag rather than discard, because
 * mishit RATE is itself one of the more useful things in this dataset.
 *
 * `refBallMph` is the club's reference ball speed (see referenceSpeeds).
 */
export function classify(
  m: RangeStrokeMeasurement,
  refBallMph: number | null,
  model?: CarryModel | null,
): { quality: ShotQuality; reason: string | null } {
  const ball = m.ballSpeed == null ? null : m.ballSpeed * MS_TO_MPH;
  if (ball == null || refBallMph == null) return { quality: 'unknown', reason: null };

  if (ball < refBallMph * 0.75) {
    return { quality: 'mishit', reason: `ball speed ${ball.toFixed(0)} mph vs ${refBallMph.toFixed(0)} reference` };
  }
  // A near-zero launch angle with real ball speed is a top or a thin.
  if (m.launchAngle != null && m.launchAngle < 5 && ball > refBallMph * 0.6) {
    return { quality: 'mishit', reason: `launch ${m.launchAngle.toFixed(1)}° — topped/thinned` };
  }
  // Speed and angle both look fine but the ball did not go where that implies.
  // This is the rule that catches glancing strikes the first two miss.
  if (model) {
    const { efficiency } = carryEfficiency(m, model);
    if (efficiency != null && efficiency < 0.85) {
      return {
        quality: 'mishit',
        reason: `carried ${(efficiency * 100).toFixed(0)}% of expected for these launch conditions`,
      };
    }
  }
  return { quality: 'good', reason: null };
}

/**
 * Per-club reference ball speed: the 90th percentile of observed ball speed.
 *
 * Deliberately not the max — one flushed outlier should not define the
 * baseline for every other shot.
 */
export function referenceSpeeds(strokes: RangeStroke[]): Map<string, number> {
  const byClub = new Map<string, number[]>();
  for (const s of strokes) {
    const bs = s.proBall?.ballSpeed;
    if (!s.club || bs == null) continue;
    if (!byClub.has(s.club)) byClub.set(s.club, []);
    byClub.get(s.club)!.push(bs * MS_TO_MPH);
  }
  const out = new Map<string, number>();
  for (const [club, speeds] of byClub) {
    speeds.sort((a, b) => a - b);
    out.set(club, speeds[Math.floor(speeds.length * 0.9)] ?? speeds[speeds.length - 1]);
  }
  return out;
}

export function toShot(
  stroke: RangeStroke,
  sessionId: string,
  refSpeeds: Map<string, number>,
  bayOffsets?: Map<string, BayOffset>,
  loftBaselines?: Map<string, number>,
  ctx?: { sessionTime?: string; shotIndex?: number; model?: CarryModel | null },
): Shot {
  // Merge per field: pro-ball is what the app shows, but it returns null for
  // landingAngle / ballSpinEffective / reducedAccuracy, which site populates.
  const m = mergeMeasurement(stroke.proBall, stroke.raw);
  const isRawBall = stroke.proBall == null && stroke.raw != null;

  if (!m) {
    return {
      id: stroke.dbId,
      sessionId,
      time: stroke.time,
      sessionTime: ctx?.sessionTime ?? stroke.time,
      shotIndex: ctx?.shotIndex ?? 0,
      club: stroke.club,
      bayName: stroke.bayName,
      carryYd: null, totalYd: null, carrySideFt: null, ballMph: null,
      spinRpm: null, spinAxis: null, launchAngle: null, launchDirection: null,
      landingAngle: null, peakFt: null,
      launchDirectionAdj: null, carrySideAdjFt: null, bayOffsetDeg: null,
      offlineFt: null,
      curveFt: null, curveDeg: null,
      estClubMph: null, loftDelta: null, loftDeltaVsOwn: null,
      expectedCarryYd: null, carryEfficiency: null,
      quality: 'unknown', qualityReason: 'no measurement',
      isRawBall: false, accuracyFlags: [],
    };
  }

  const cfg = clubConfig(stroke.club);
  const ballMph = m.ballSpeed == null ? null : m.ballSpeed * MS_TO_MPH;
  const { ft: curveFt, deg: curveDeg } = curvature(m);
  const { quality, reason } = classify(
    m, refSpeeds.get(stroke.club ?? '') ?? null, ctx?.model,
  );
  const eff = carryEfficiency(m, ctx?.model ?? null);

  const bay = bayOffsets?.get(offsetKey(stroke.bayName, stroke.targetId));
  const adj = applyBayOffset(m, bay?.offsetDeg);
  const carrySideAdjFt = adj.carrySide == null ? null : adj.carrySide * M_TO_FT;

  const loftDelta =
    m.launchAngle != null && cfg?.loft != null ? m.launchAngle - cfg.loft : null;
  const baseline = loftBaselines?.get(stroke.club ?? '');

  return {
    id: stroke.dbId,
    sessionId,
    time: stroke.time,
    sessionTime: ctx?.sessionTime ?? stroke.time,
    shotIndex: ctx?.shotIndex ?? 0,
    club: stroke.club,
    bayName: stroke.bayName,

    carryYd: m.carry == null ? null : m.carry * M_TO_YD,
    totalYd: m.total == null ? null : m.total * M_TO_YD,
    carrySideFt: m.carrySide == null ? null : m.carrySide * M_TO_FT,
    ballMph,
    spinRpm: m.ballSpin,
    spinAxis: m.spinAxis,
    launchAngle: m.launchAngle,
    launchDirection: m.launchDirection,
    landingAngle: m.landingAngle,
    peakFt: m.maxHeight == null ? null : m.maxHeight * M_TO_FT,

    launchDirectionAdj: adj.launchDirection,
    carrySideAdjFt,
    bayOffsetDeg: bay?.offsetDeg ?? null,
    offlineFt: carrySideAdjFt == null ? null : Math.abs(carrySideAdjFt),

    curveFt,
    curveDeg,
    estClubMph:
      ballMph != null && cfg?.assumedSmash ? ballMph / cfg.assumedSmash : null,
    loftDelta,
    loftDeltaVsOwn:
      loftDelta != null && baseline != null ? loftDelta - baseline : null,
    expectedCarryYd: eff.expectedYd,
    carryEfficiency: eff.efficiency,

    quality,
    qualityReason: reason,
    isRawBall,
    accuracyFlags: m.reducedAccuracy ?? [],
  };
}

/**
 * Per-club median loftDelta over clean strikes — the baseline that makes
 * loftDeltaVsOwn meaningful.
 */
export function loftBaselines(
  strokes: RangeStroke[],
  refSpeeds: Map<string, number>,
): Map<string, number> {
  const byClub = new Map<string, number[]>();
  for (const s of strokes) {
    const m = mergeMeasurement(s.proBall, s.raw);
    const cfg = clubConfig(s.club);
    if (!m || !s.club || !cfg?.loft || m.launchAngle == null) continue;
    if (classify(m, refSpeeds.get(s.club) ?? null).quality !== 'good') continue;
    if (!byClub.has(s.club)) byClub.set(s.club, []);
    byClub.get(s.club)!.push(m.launchAngle - cfg.loft);
  }
  const out = new Map<string, number>();
  for (const [club, v] of byClub) {
    v.sort((a, b) => a - b);
    const mid = Math.floor(v.length / 2);
    out.set(club, v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2);
  }
  return out;
}
