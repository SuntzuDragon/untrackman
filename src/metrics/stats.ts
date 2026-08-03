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

/** Per-club numbers within a single session. */
export interface ClubSessionStats {
  shots: number;
  clean: number;
  mishitRate: number | null;
  carryMedian: number | null;
  ballMphMedian: number | null;
  curveMean: number | null;
  offlineMean: number | null;
  launchMean: number | null;
}

export interface SessionTrend {
  sessionId: string;
  date: string;
  shots: number;
  mishitRate: number | null;
  ballMphMean: number | null;
  byClub: Record<string, ClubSessionStats>;
}

/**
 * Minimum shots with a club in one session before its per-club trend point is
 * worth plotting.
 *
 * With ~5 shots the rate jumps in 20-point steps, which reads as a dramatic
 * swing that is really just sampling. Series below this are suppressed rather
 * than drawn misleadingly.
 */
export const MIN_SHOTS_FOR_TREND = 5;

function clubSession(pool: Shot[]): ClubSessionStats {
  const good = pool.filter((s) => s.quality === 'good');
  const mishits = pool.filter((s) => s.quality === 'mishit');
  const carries = nums(good, 'carryYd').sort((a, b) => a - b);
  const speeds = nums(good, 'ballMph').sort((a, b) => a - b);
  return {
    shots: pool.length,
    clean: good.length,
    // Mishit rate is over ALL shots — that is the point of it.
    mishitRate: pool.length ? mishits.length / pool.length : null,
    // Everything else is over clean strikes only.
    carryMedian: quantile(carries, 0.5),
    ballMphMedian: quantile(speeds, 0.5),
    curveMean: mean(nums(good, 'curveFt')),
    offlineMean: mean(nums(good, 'offlineFt')),
    launchMean: mean(nums(good, 'launchAngle')),
  };
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
    const mishits = all.filter((s) => s.quality === 'mishit');
    const byClub: Record<string, ClubSessionStats> = {};
    for (const c of CLUBS) {
      const pool = all.filter((s) => s.club === c.trackmanId);
      if (pool.length) byClub[c.trackmanId] = clubSession(pool);
    }
    rows.push({
      sessionId,
      date: all[0]?.time ?? '',
      shots: all.length,
      mishitRate: all.length ? mishits.length / all.length : null,
      ballMphMean: mean(nums(all.filter((s) => s.quality === 'good'), 'ballMph')),
      byClub,
    });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

/** Metrics the trend chart can plot, keyed by what the UI shows. */
export interface TrendMetric {
  key: string;
  label: string;
  axisLabel: string;
  get: (c: ClubSessionStats) => number | null;
  /** Rendered as a percentage axis. */
  percent?: boolean;
  /** Down is improvement — used to colour the session-over-session delta. */
  lowerIsBetter?: boolean;
  /** Draw a zero rule (curve, offline). */
  zeroLine?: boolean;
}

export const TREND_METRICS: TrendMetric[] = [
  {
    key: 'mishitRate',
    label: 'Mishit rate',
    axisLabel: 'Mishit rate',
    get: (c) => c.mishitRate,
    percent: true,
    lowerIsBetter: true,
  },
  {
    key: 'carryMedian',
    label: 'Median carry',
    axisLabel: 'Carry (yd)',
    get: (c) => c.carryMedian,
  },
  {
    key: 'ballMphMedian',
    label: 'Ball speed',
    axisLabel: 'Ball speed (mph)',
    get: (c) => c.ballMphMedian,
  },
  {
    key: 'curveMean',
    label: 'Mean curve',
    axisLabel: 'Curve (ft) — left \u2190 0 \u2192 right',
    get: (c) => c.curveMean,
    zeroLine: true,
  },
  {
    key: 'offlineMean',
    label: 'Mean offline',
    axisLabel: 'Offline (ft)',
    get: (c) => c.offlineMean,
    lowerIsBetter: true,
  },
  {
    key: 'launchMean',
    label: 'Launch angle',
    axisLabel: 'Launch (\u00b0)',
    get: (c) => c.launchMean,
  },
];

/**
 * Least-squares fit of a metric against time for one club.
 *
 * Regressed on actual dates rather than session index: sessions are unevenly
 * spaced (this account has gaps of 1 day and of 15), and treating them as
 * equidistant would distort the slope.
 *
 * Slope is reported per week because that is the cadence practice happens on.
 * `r2` matters as much as the slope here — with 6-8 points a steep line through
 * scattered data means very little, and the UI should say so.
 */
export interface TrendFit {
  /** Change in the metric per week. */
  slopePerWeek: number;
  /** 0-1. Below ~0.3 the slope is not distinguishable from noise. */
  r2: number;
  /** Sessions that met the minimum-shots bar. */
  n: number;
  /** Fitted value at the first and last session, for drawing the line. */
  from: { date: string; value: number };
  to: { date: string; value: number };
}

const DAY = 86_400_000;

export function trendFit(
  trends: SessionTrend[],
  club: string,
  metric: TrendMetric,
): TrendFit | null {
  const pts: { t: number; v: number; date: string }[] = [];
  for (const t of trends) {
    const c = t.byClub[club];
    if (!c || c.shots < MIN_SHOTS_FOR_TREND) continue;
    const v = metric.get(c);
    if (v == null) continue;
    pts.push({ t: new Date(t.date).getTime(), v, date: t.date });
  }
  if (pts.length < 3) return null;

  const t0 = pts[0].t;
  const xs = pts.map((p) => (p.t - t0) / DAY);
  const ys = pts.map((p) => p.v);
  const n = pts.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;

  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  // All sessions on the same day, or a perfectly flat metric.
  if (sxx === 0) return null;

  const slopePerDay = sxy / sxx;
  const intercept = my - slopePerDay * mx;
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);

  const lastX = xs[xs.length - 1];
  return {
    slopePerWeek: slopePerDay * 7,
    r2,
    n,
    from: { date: pts[0].date, value: intercept },
    to: { date: pts[n - 1].date, value: intercept + slopePerDay * lastX },
  };
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
