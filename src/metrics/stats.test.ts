/**
 * Aggregation, focused on the parts the dispersion tab reads.
 */

import { describe, expect, it } from 'vitest';
import fixtures from './__fixtures__/validation-shots.json';
import { toShot, referenceSpeeds } from './shot';
import { offsetKey, type BayOffset } from './bays';
import {
  clubStats, dispersionEllipse, AS_MEASURED, BAY_CORRECTED, MIN_SHOTS_FOR_ELLIPSE,
} from './stats';
import type { RangeStroke } from '../api/types';

const strokes = fixtures as unknown as RangeStroke[];
const refs = referenceSpeeds(strokes);

const OFFSET: BayOffset = {
  bay: 'BAY-A',
  targetId: 'target-A',
  offsetDeg: 16,
  source: 'measured',
  n: 50,
  spreadDeg: 8,
  stderrDeg: 1.05,
  geometricDeg: 14,
  residualDeg: 2,
  clubs: 4,
};
const offsets = new Map([[offsetKey('BAY-A', 'target-A'), OFFSET]]);

/** Enough copies of the fixture 4-iron to clear every minimum. */
const fourIron = strokes.find((s) => s.club === '4Iron')!;
const many = Array.from({ length: MIN_SHOTS_FOR_ELLIPSE }, (_, i) =>
  toShot({ ...fourIron, dbId: `s${i}` }, 'sess', refs, offsets),
);

describe('the bay-correction toggle reaches every number', () => {
  /**
   * Regression: the chart read positions through an accessor and switched with
   * the toggle, while clubStats and dispersionEllipse read the adjusted fields
   * directly. Unticking "Bay-corrected" flipped the plot to raw and left the
   * Centre and Side σ columns underneath it silently corrected.
   */
  it('gives clubStats different sides for the two placements', () => {
    const corrected = clubStats(many, true, BAY_CORRECTED)[0];
    const measured = clubStats(many, true, AS_MEASURED)[0];
    expect(corrected.sideMean).not.toBeCloseTo(measured.sideMean!, 1);
    expect(corrected.offlineMean).toBeLessThan(measured.offlineMean!);
  });

  it('gives dispersionEllipse different centres for the two placements', () => {
    const corrected = dispersionEllipse(many, BAY_CORRECTED)!;
    const measured = dispersionEllipse(many, AS_MEASURED)!;
    expect(corrected.cx).not.toBeCloseTo(measured.cx, 1);
    // The raw 4-iron finished 20° right of the target line; correcting a 16°
    // bay pulls it most of the way back.
    expect(Math.abs(corrected.cx)).toBeLessThan(Math.abs(measured.cx));
  });

  it('defaults to bay-corrected when no placement is given', () => {
    expect(dispersionEllipse(many)!.cx).toBeCloseTo(
      dispersionEllipse(many, BAY_CORRECTED)!.cx,
      9,
    );
    expect(clubStats(many, true)[0].sideMean).toBeCloseTo(
      clubStats(many, true, BAY_CORRECTED)[0].sideMean!,
      9,
    );
  });

  it('plots down-range distance, not radial carry', () => {
    // 4-iron: 160.8 m radial, 56 m offline -> 150.7 m down range = 164.8 yd.
    expect(dispersionEllipse(many, AS_MEASURED)!.cy).toBeCloseTo(164.8, 0);
    expect(many[0].carryYd!).toBeCloseTo(175.8, 0);
  });
});

describe('ellipse sample size', () => {
  it('refuses to draw a ring from a handful of shots', () => {
    expect(dispersionEllipse(many.slice(0, MIN_SHOTS_FOR_ELLIPSE - 1))).toBeNull();
    expect(dispersionEllipse(many)).not.toBeNull();
  });
});

describe('start line relative to the bay average', () => {
  /**
   * Reported as a median, matching the estimator it is measured against — the
   * offset is itself a median, so a mean here compared two different things.
   */
  it('is the median adjusted launch direction', () => {
    const s = clubStats(many, true)[0];
    expect(s.launchDirAdjMedian!).toBeCloseTo(many[0].launchDirection! - 16, 6);
  });
});
