/**
 * Aggregation: per-club distributions, gapping, and cross-session trends.
 */

import { CLUBS, MISSING_SLOTS, clubConfig, clubLabel, clubOrder } from './clubs';
import type { Shot } from './shot';

export const mean = (v: number[]): number | null =>
  v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;

export function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function stdev(v: number[]): number | null {
  if (v.length < 2) return null;
  const m = mean(v)!;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
}

const nums = (shots: Shot[], key: keyof Shot): number[] =>
  shots.map((s) => s[key]).filter((v): v is number => typeof v === 'number');

export interface ClubStats {
  club: string;
  label: string;
  loft: number | null;
  order: number;
  n: number;
  nGood: number;
  nMishit: number;
  mishitRate: number | null;

  carryMean: number | null;
  carryMedian: number | null;
  carryStdev: number | null;
  carryP25: number | null;
  carryP75: number | null;
  carryMax: number | null;

  /** Bay-corrected lateral position, feet. */
  sideMean: number | null;
  sideStdev: number | null;
  /** Mean absolute offline distance after bay correction, feet. */
  offlineMean: number | null;
  /** Mean bay-corrected launch direction — should sit near 0 once corrected. */
  launchDirAdjMean: number | null;

  curveMean: number | null;
  curveMedian: number | null;
  curveStdev: number | null;
  /** Share of good shots that curved right. 0.5 = two-way miss. */
  fadeShare: number | null;

  ballMphMean: number | null;
  estClubMphMean: number | null;
  launchMean: number | null;
  loftDeltaMean: number | null;
  spinMean: number | null;
}

/**
 * Per-club stats.
 *
 * `goodOnly` drives everything distance-related. With mishits included the
 * medians are meaningless — the 6-iron median carry is 73.7 yd across the full
 * set versus roughly 140 for clean contact. Mishit RATE is reported separately
 * and is computed over all shots regardless.
 */
export function clubStats(shots: Shot[], goodOnly = true): ClubStats[] {
  const byClub = new Map<string, Shot[]>();
  for (const s of shots) {
    if (!s.club) continue;
    if (!byClub.has(s.club)) byClub.set(s.club, []);
    byClub.get(s.club)!.push(s);
  }

  const out: ClubStats[] = [];
  for (const [club, all] of byClub) {
    const good = all.filter((s) => s.quality === 'good');
    const mishits = all.filter((s) => s.quality === 'mishit');
    const pool = goodOnly ? good : all;

    const carries = nums(pool, 'carryYd').sort((a, b) => a - b);
    // Bay-corrected: raw carrySide carries up to 17 deg of bay aim error.
    const sides = nums(pool, 'carrySideAdjFt');
    const curves = nums(pool, 'curveFt').sort((a, b) => a - b);

    out.push({
      club,
      label: clubLabel(club),
      loft: clubConfig(club)?.loft ?? null,
      order: clubOrder(club),
      n: all.length,
      nGood: good.length,
      nMishit: mishits.length,
      mishitRate: all.length ? mishits.length / all.length : null,

      carryMean: mean(carries),
      carryMedian: quantile(carries, 0.5),
      carryStdev: stdev(carries),
      carryP25: quantile(carries, 0.25),
      carryP75: quantile(carries, 0.75),
      carryMax: carries.length ? carries[carries.length - 1] : null,

      sideMean: mean(sides),
      sideStdev: stdev(sides),
      offlineMean: mean(nums(pool, 'offlineFt')),
      launchDirAdjMean: mean(nums(pool, 'launchDirectionAdj')),

      curveMean: mean(curves),
      curveMedian: quantile(curves, 0.5),
      curveStdev: stdev(curves),
      fadeShare: curves.length ? curves.filter((c) => c > 0).length / curves.length : null,

      ballMphMean: mean(nums(pool, 'ballMph')),
      estClubMphMean: mean(nums(pool, 'estClubMph')),
      launchMean: mean(nums(pool, 'launchAngle')),
      loftDeltaMean: mean(nums(pool, 'loftDelta')),
      spinMean: mean(nums(pool, 'spinRpm')),
    });
  }

  return out.sort((a, b) => a.order - b.order);
}

export interface GapRow {
  from: string;
  to: string;
  fromLabel: string;
  toLabel: string;
  /** Gap between the two clubs' median carries, yards. Negative = inverted. */
  gapYd: number | null;
  loftGap: number | null;
  status: 'ok' | 'tight' | 'overlap' | 'inverted' | 'missing-club';
  note?: string;
}

/**
 * Adjacent-club gapping.
 *
 * Bands are deliberately loose: 8–20 yards is a normal iron gap. Anything
 * under 8 is crowded, and a negative gap means the shorter club is going
 * further — which is what actually happens between this 5-iron and 6-iron.
 */
export function gapping(stats: ClubStats[]): GapRow[] {
  const present = stats.filter((s) => s.carryMedian != null).sort((a, b) => a.order - b.order);
  const rows: GapRow[] = [];

  for (let i = 0; i < present.length - 1; i++) {
    const a = present[i];
    const b = present[i + 1];
    const gap = a.carryMedian! - b.carryMedian!;
    const loftGap = a.loft != null && b.loft != null ? b.loft - a.loft : null;

    let status: GapRow['status'] = 'ok';
    if (gap < 0) status = 'inverted';
    else if (gap < 4) status = 'overlap';
    else if (gap < 8) status = 'tight';

    // Surface a missing slot sitting between these two clubs.
    const missing = MISSING_SLOTS.find(
      (m) => m.between[0] === a.club && m.between[1] === b.club,
    );

    rows.push({
      from: a.club,
      to: b.club,
      fromLabel: a.label,
      toLabel: b.label,
      gapYd: gap,
      loftGap,
      status: missing ? 'missing-club' : status,
      note: missing?.reason,
    });
  }
  return rows;
}

export interface SessionTrend {
  sessionId: string;
  date: string;
  shots: number;
  mishitRate: number | null;
  carryMedianByClub: Record<string, number | null>;
  curveMeanByClub: Record<string, number | null>;
  ballMphMean: number | null;
}

/**
 * Cross-session trends — the reason this project exists. Trackman shows one
 * session at a time and never compares them.
 */
export function sessionTrends(shots: Shot[]): SessionTrend[] {
  const bySession = new Map<string, Shot[]>();
  for (const s of shots) {
    if (!bySession.has(s.sessionId)) bySession.set(s.sessionId, []);
    bySession.get(s.sessionId)!.push(s);
  }

  const rows: SessionTrend[] = [];
  for (const [sessionId, all] of bySession) {
    const good = all.filter((s) => s.quality === 'good');
    const mishits = all.filter((s) => s.quality === 'mishit');

    const carryMedianByClub: Record<string, number | null> = {};
    const curveMeanByClub: Record<string, number | null> = {};
    for (const c of CLUBS) {
      const pool = good.filter((s) => s.club === c.trackmanId);
      const carries = nums(pool, 'carryYd').sort((a, b) => a - b);
      carryMedianByClub[c.trackmanId] = quantile(carries, 0.5);
      curveMeanByClub[c.trackmanId] = mean(nums(pool, 'curveFt'));
    }

    rows.push({
      sessionId,
      date: all[0]?.time ?? '',
      shots: all.length,
      mishitRate: all.length ? mishits.length / all.length : null,
      carryMedianByClub,
      curveMeanByClub,
      ballMphMean: mean(nums(good, 'ballMph')),
    });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Dispersion ellipse: 1-sigma covariance ellipse over (carrySide, carry).
 * Returns centre, semi-axes and rotation for rendering.
 */
export function dispersionEllipse(shots: Shot[]): {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  angleDeg: number;
  n: number;
} | null {
  const pts = shots
    .filter((s) => s.carrySideAdjFt != null && s.carryYd != null)
    .map((s) => [s.carrySideAdjFt! / 3, s.carryYd!] as const); // side ft -> yd
  if (pts.length < 3) return null;

  const cx = mean(pts.map((p) => p[0]))!;
  const cy = mean(pts.map((p) => p[1]))!;
  let vxx = 0, vyy = 0, vxy = 0;
  for (const [x, y] of pts) {
    vxx += (x - cx) ** 2;
    vyy += (y - cy) ** 2;
    vxy += (x - cx) * (y - cy);
  }
  const n = pts.length;
  vxx /= n - 1;
  vyy /= n - 1;
  vxy /= n - 1;

  // Eigenvalues of the 2x2 covariance matrix.
  const tr = vxx + vyy;
  const det = vxx * vyy - vxy * vxy;
  const disc = Math.sqrt(Math.max(0, (tr / 2) ** 2 - det));
  const l1 = tr / 2 + disc;
  const l2 = tr / 2 - disc;

  const angleDeg = (Math.atan2(l1 - vxx, vxy) * 180) / Math.PI;

  return {
    cx,
    cy,
    rx: Math.sqrt(Math.max(0, l1)),
    ry: Math.sqrt(Math.max(0, l2)),
    angleDeg: Number.isFinite(angleDeg) ? angleDeg : 0,
    n,
  };
}

/** CSV export — flat, one row per shot. */
export function toCsv(shots: Shot[]): string {
  const cols: (keyof Shot)[] = [
    'id', 'sessionId', 'time', 'club', 'bayName',
    'carryYd', 'totalYd', 'carrySideFt', 'ballMph', 'spinRpm', 'spinAxis',
    'launchAngle', 'launchDirection', 'landingAngle', 'peakFt',
    'launchDirectionAdj', 'carrySideAdjFt', 'bayOffsetDeg', 'offlineFt',
    'curveFt', 'curveDeg', 'estClubMph', 'loftDelta', 'loftDeltaVsOwn',
    'quality', 'qualityReason', 'isRawBall',
  ];
  const esc = (v: unknown) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(',')];
  for (const s of shots) lines.push(cols.map((c) => esc(s[c])).join(','));
  return lines.join('\n');
}
