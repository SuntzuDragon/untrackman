/**
 * Club configuration.
 *
 * `trackmanId` values are the exact strings the API returns in RangeStroke.club
 * — verified against the Phase 0 dump, which contained: Driver, 4Iron, 5Iron,
 * 6Iron, 8Iron, 9Iron.
 *
 * Lofts are STATIC lofts, used as the baseline for the dynamic-loft proxy.
 * Anything marked `loftConfidence: 'assumed'` should be measured or confirmed
 * before you read much into the launch-vs-loft numbers for that club.
 */

export type LoftConfidence = 'verified' | 'assumed' | 'adjustable';

export interface ClubConfig {
  trackmanId: string;
  label: string;
  model: string;
  /** Static loft, degrees. */
  loft: number | null;
  loftConfidence: LoftConfidence;
  /** Ordering for gapping charts — descending expected distance. */
  order: number;
  /**
   * Smash factor used to back out an ESTIMATED club speed. The range unit does
   * not measure club speed or smash, so anything derived from this is an
   * estimate and must be labelled as one.
   */
  assumedSmash: number | null;
  note?: string;
}

export const CLUBS: ClubConfig[] = [
  {
    trackmanId: 'Driver',
    label: 'Driver',
    model: 'Callaway RAZR Fit Xtreme',
    loft: 10.5,
    loftConfidence: 'adjustable',
    order: 0,
    assumedSmash: 1.48,
    note: 'RAZR Fit Xtreme has an adjustable hosel (±2°) and a movable weight. 10.5° is the nominal setting — confirm where yours is set.',
  },
  {
    trackmanId: '4Iron',
    label: '4 Iron',
    model: 'Mizuno MP-63',
    loft: 24,
    loftConfidence: 'verified',
    order: 1,
    assumedSmash: 1.41,
  },
  {
    trackmanId: '5Iron',
    label: '5 Iron',
    model: 'Mizuno MP-62',
    loft: 27,
    loftConfidence: 'verified',
    order: 2,
    assumedSmash: 1.41,
  },
  {
    trackmanId: '6Iron',
    label: '6 Iron',
    model: 'Mizuno MP-62',
    loft: 31,
    loftConfidence: 'verified',
    order: 3,
    assumedSmash: 1.38,
  },
  {
    trackmanId: '8Iron',
    label: '8 Iron',
    model: 'Mizuno MP-63',
    loft: 38,
    loftConfidence: 'verified',
    order: 5,
    assumedSmash: 1.36,
  },
  {
    trackmanId: '9Iron',
    label: '9 Iron',
    model: 'Mizuno JPX 900',
    loft: 41,
    loftConfidence: 'assumed',
    order: 6,
    assumedSmash: 1.34,
    note: 'JPX 900 loft varies by model: Forged 41°, Tour 42°, Hot Metal 37°. Seeded as Forged — confirm before trusting launch-vs-loft for this club.',
  },
  {
    trackmanId: 'PitchingWedge',
    label: 'Pitching Wedge',
    model: 'Mizuno MP-63',
    loft: 46,
    loftConfidence: 'verified',
    order: 7,
    assumedSmash: 1.32,
    note: 'In the bag but absent from all 7 range sessions.',
  },
  {
    trackmanId: 'GapWedge',
    label: 'Gap Wedge',
    model: 'Cleveland 588 RTX 2.0',
    loft: 52,
    loftConfidence: 'verified',
    order: 8,
    assumedSmash: 1.28,
    note: 'In the bag but absent from all 7 range sessions.',
  },
  {
    trackmanId: 'SandWedge',
    label: 'Sand Wedge',
    model: 'Cleveland CG16',
    loft: 56,
    loftConfidence: 'verified',
    order: 9,
    assumedSmash: 1.24,
    note: 'In the bag but absent from all 7 range sessions.',
  },
];

/**
 * The 7-iron slot is empty. Between the 6i (31°) and the 8i (38°) there is a 7°
 * loft gap where every other adjacent pair in the set is 3–5°. That is roughly
 * a 15-yard hole in the middle of the bag, and it is a bag problem rather than
 * a swing problem — worth surfacing in the gapping view rather than leaving the
 * user to infer it from a blank space on a chart.
 */
export const MISSING_SLOTS = [
  {
    label: '7 Iron',
    order: 4,
    expectedLoft: 34.5,
    between: ['6Iron', '8Iron'] as const,
    reason:
      'No 7-iron in the bag. 6i 31° to 8i 38° is a 7° gap where the rest of the set steps 3–5°, leaving roughly a 15-yard hole.',
  },
];

const BY_ID = new Map(CLUBS.map((c) => [c.trackmanId, c]));

export function clubConfig(trackmanId: string | null): ClubConfig | undefined {
  return trackmanId ? BY_ID.get(trackmanId) : undefined;
}

export function clubLabel(trackmanId: string | null): string {
  return clubConfig(trackmanId)?.label ?? trackmanId ?? 'Unknown';
}

export function clubOrder(trackmanId: string | null): number {
  return clubConfig(trackmanId)?.order ?? 99;
}
