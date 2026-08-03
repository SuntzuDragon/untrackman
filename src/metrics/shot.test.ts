/**
 * Regression tests against two real shots whose numbers were read off the
 * TrackMan phone app. If the pipeline ever stops reproducing these, something
 * upstream changed — a unit, a measurement variant, or a sign.
 *
 * Fixture is verbatim API output, not hand-written.
 */

import { describe, expect, it } from 'vitest';
import fixtures from './__fixtures__/validation-shots.json';
import { toShot, referenceSpeeds, curvature, mergeMeasurement } from './shot';
import { offsetKey } from './bays';
import {
  DEFAULT_BAG, setBag, orderClubsFromData, clubLabel, isUnbagged,
} from './clubs';
import type { RangeStroke } from '../api/types';

const strokes = fixtures as unknown as RangeStroke[];
const refs = referenceSpeeds(strokes);
const shots = strokes.map((s) => toShot(s, 'test-session', refs));

const six = shots.find((s) => s.club === '6Iron')!;
const four = shots.find((s) => s.club === '4Iron')!;

/** Values as displayed in the TrackMan app. */
const APP = {
  '6Iron': { carry: 159, ball: 115, launch: 18.2, peak: 85, dir: 10.9, side: 11 },
  '4Iron': { carry: 176, ball: 125, launch: 16.6, peak: 102, dir: 19.3, side: 184 },
};

describe('app-displayed values reproduce', () => {
  it('6 iron matches the app', () => {
    expect(six.carryYd!).toBeCloseTo(APP['6Iron'].carry, -0.5);
    expect(six.ballMph!).toBeCloseTo(APP['6Iron'].ball, -0.5);
    expect(six.launchAngle!).toBeCloseTo(APP['6Iron'].launch, 0);
    expect(six.peakFt!).toBeCloseTo(APP['6Iron'].peak, -0.5);
    expect(six.launchDirection!).toBeCloseTo(APP['6Iron'].dir, 0);
    expect(six.carrySideFt!).toBeCloseTo(APP['6Iron'].side, -0.5);
  });

  it('4 iron matches the app', () => {
    expect(four.carryYd!).toBeCloseTo(APP['4Iron'].carry, -0.5);
    expect(four.ballMph!).toBeCloseTo(APP['4Iron'].ball, -0.5);
    expect(four.launchAngle!).toBeCloseTo(APP['4Iron'].launch, 0);
    expect(four.peakFt!).toBeCloseTo(APP['4Iron'].peak, -0.5);
    expect(four.launchDirection!).toBeCloseTo(APP['4Iron'].dir, 0);
    expect(four.carrySideFt!).toBeCloseTo(APP['4Iron'].side, -0.5);
  });
});

describe('curvature sign convention', () => {
  /**
   * The 6 iron started 10.92° right and finished only 1.4° right — it moved
   * LEFT, so curvature must be negative. The originally specified formula
   * (launchDirection − finishAngle) returns +9.5 for this shot, which would
   * read as a fade. This test exists to keep that inversion from coming back.
   */
  it('reports a draw as negative', () => {
    expect(six.curveFt!).toBeLessThan(0);
    expect(six.curveDeg!).toBeLessThan(0);
    // spinAxis tilts left on a draw — the two must agree.
    expect(six.spinAxis!).toBeLessThan(0);
  });

  it('reports a near-straight push as ~zero curve', () => {
    // 4 iron: launched 19.3° right and flew essentially straight. The huge
    // 184 ft carry side is bay alignment, not shape.
    expect(Math.abs(four.curveDeg!)).toBeLessThan(3);
    expect(four.spinAxis!).toBeGreaterThan(0);
  });

  it('curveDeg and curveFt agree in sign', () => {
    for (const s of shots) {
      if (s.curveFt != null && s.curveDeg != null && Math.abs(s.curveFt) > 1) {
        expect(Math.sign(s.curveFt)).toBe(Math.sign(s.curveDeg));
      }
    }
  });

  it('returns nulls when curve is absent', () => {
    expect(curvature({ curve: null } as any)).toEqual({ ft: null, deg: null });
  });
});

describe('derived metrics', () => {
  it('flags estimated club speed for a known smash assumption', () => {
    // 6 iron assumed smash 1.38 — this is an ESTIMATE, the unit measures neither
    // club speed nor smash factor.
    expect(six.estClubMph!).toBeCloseTo(six.ballMph! / 1.38, 3);
  });

  it('computes launch angle relative to static loft', () => {
    // 6 iron MP-62 is 31 deg static.
    expect(six.loftDelta!).toBeCloseTo(six.launchAngle! - 31, 3);
  });

  it('treats these flushed shots as clean strikes', () => {
    expect(six.quality).toBe('good');
    expect(four.quality).toBe('good');
  });

  it('uses the pro-ball view, not raw range ball', () => {
    expect(six.isRawBall).toBe(false);
    // The two variants genuinely differ — if they did not, the distinction
    // would not be worth carrying.
    const raw = strokes.find((s) => s.club === '6Iron')!.raw!;
    expect(Math.abs(raw.carry! - strokes.find((s) => s.club === '6Iron')!.proBall!.carry!))
      .toBeGreaterThan(0.5);
  });
});

describe('measurement merge (PRO_BALL null-field fallback)', () => {
  /**
   * PRO_BALL_MEASUREMENT returns null for landingAngle, ballSpinEffective and
   * reducedAccuracy on all 412 strokes, while SITE_MEASUREMENT populates all
   * three. Preferring the pro-ball object wholesale silently dropped them.
   */
  it('back-fills landingAngle from the site measurement', () => {
    for (const s of shots) {
      expect(s.landingAngle).not.toBeNull();
    }
  });

  it('back-fills reducedAccuracy flags', () => {
    const raw = strokes[0].raw!;
    expect(strokes[0].proBall!.reducedAccuracy).toBeNull();
    const merged = mergeMeasurement(strokes[0].proBall, raw)!;
    expect(merged.reducedAccuracy).toEqual(raw.reducedAccuracy);
  });

  it('does NOT overwrite normalized measurements with raw ones', () => {
    const st = strokes[0];
    const merged = mergeMeasurement(st.proBall, st.raw)!;
    // carry must stay pro-ball, since mixing normalization bases would make
    // the numbers incomparable.
    expect(merged.carry).toBe(st.proBall!.carry);
    expect(merged.carry).not.toBe(st.raw!.carry);
  });
});

describe('bay alignment correction', () => {
  const OFFSET = {
    bay: 'BAY16',
    targetId: 'tgt-1',
    offsetDeg: 16,
    n: 50,
    spreadDeg: 8,
    geometricDeg: -22,
  };
  const offsetsFor = (bay: string, targetId: string) =>
    new Map([[offsetKey(bay, targetId), { ...OFFSET, bay, targetId }]]);

  it('removes the bay offset from launch direction', () => {
    const offsets = offsetsFor('BAY16', 'tgt-1');
    const st = { ...strokes[0], bayName: 'BAY16', targetId: 'tgt-1' };
    const corrected = toShot(st, 's', refs, offsets);
    const uncorrected = toShot(strokes[0], 's', refs);
    expect(corrected.launchDirectionAdj!).toBeCloseTo(
      uncorrected.launchDirection! - 16,
      6,
    );
    expect(corrected.bayOffsetDeg).toBe(16);
  });

  it('leaves direction untouched when the bay is unknown', () => {
    const s = toShot(strokes[0], 's', refs, new Map());
    expect(s.launchDirectionAdj).toBe(s.launchDirection);
    expect(s.bayOffsetDeg).toBeNull();
  });

  it('does not change curvature — it is already launch-line relative', () => {
    const offsets = offsetsFor('BAY16', 'tgt-1');
    const st = { ...strokes[0], bayName: 'BAY16', targetId: 'tgt-1' };
    expect(toShot(st, 's', refs, offsets).curveFt).toBe(
      toShot(strokes[0], 's', refs).curveFt,
    );
  });

  /**
   * One bay can host several targets, and launch direction is reported against
   * the bay->target line. BAY07's two targets differ by 11.8 deg in this data,
   * so keying the offset on bay alone is wrong for both.
   */
  it('keys the offset on bay AND target, not bay alone', () => {
    const offsets = offsetsFor('BAY07', 'tgt-A');
    const matching = { ...strokes[0], bayName: 'BAY07', targetId: 'tgt-A' };
    const differentTarget = { ...strokes[0], bayName: 'BAY07', targetId: 'tgt-B' };

    expect(toShot(matching, 's', refs, offsets).bayOffsetDeg).toBe(16);
    // Same bay, different target -> the offset must NOT be reused.
    expect(toShot(differentTarget, 's', refs, offsets).bayOffsetDeg).toBeNull();
  });
});

describe('clubs the bag has never heard of', () => {
  /**
   * Regression: availableClubs was derived from the bag and intersected with the
   * data, so a club Trackman reported but the bag lacked was dropped from every
   * view. Removing the 6-iron from the bag made 118 shots vanish silently and
   * shifted the overall mishit rate from 47% to 50%.
   *
   * The data decides WHICH clubs exist; the bag only supplies metadata.
   */
  it('keeps unconfigured clubs in the ordered list', () => {
    setBag(DEFAULT_BAG.filter((c) => c.trackmanId !== '6Iron'));
    const ordered = orderClubsFromData(['Driver', '6Iron', '4Iron']);
    expect(ordered).toContain('6Iron');
    setBag(DEFAULT_BAG);
  });

  it('puts unconfigured clubs after bagged ones', () => {
    setBag(DEFAULT_BAG.filter((c) => c.trackmanId !== '6Iron'));
    const ordered = orderClubsFromData(['6Iron', 'Driver', '4Iron']);
    expect(ordered.indexOf('Driver')).toBeLessThan(ordered.indexOf('6Iron'));
    expect(ordered[ordered.length - 1]).toBe('6Iron');
    setBag(DEFAULT_BAG);
  });

  it('never invents or drops a club', () => {
    setBag(DEFAULT_BAG.filter((c) => c.trackmanId !== '6Iron'));
    const seen = ['Driver', '6Iron', '4Iron', '7Wood'];
    expect(new Set(orderClubsFromData(seen))).toEqual(new Set(seen));
    setBag(DEFAULT_BAG);
  });

  it('labels an unbagged club readably rather than as a raw id', () => {
    setBag(DEFAULT_BAG.filter((c) => c.trackmanId !== '6Iron'));
    expect(clubLabel('6Iron')).toBe('6 Iron');
    expect(clubLabel('PitchingWedge')).toBe('Pitching Wedge');
    expect(isUnbagged('6Iron')).toBe(true);
    expect(isUnbagged('Driver')).toBe(false);
    setBag(DEFAULT_BAG);
  });

  it('still produces a usable shot for an unbagged club', () => {
    setBag(DEFAULT_BAG.filter((c) => c.trackmanId !== '6Iron'));
    const s = toShot(strokes.find((x) => x.club === '6Iron')!, 'sess', refs);
    // Measurements survive; only bag-derived fields go null.
    expect(s.carryYd).not.toBeNull();
    expect(s.ballMph).not.toBeNull();
    expect(s.loftDelta).toBeNull();
    expect(s.estClubMph).toBeNull();
    setBag(DEFAULT_BAG);
  });
});
