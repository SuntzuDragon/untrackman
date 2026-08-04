/**
 * Bay alignment correction.
 *
 * The 4-iron in the validation fixture is the shot that makes all of this
 * visible: it launched 19.3° right of the selected target and flew essentially
 * straight, so its 184 ft carry side is aim, not shape.
 */

import { describe, expect, it } from 'vitest';
import fixtures from './__fixtures__/validation-shots.json';
import { applyBayOffset, computeBayOffsets, offsetKey } from './bays';
import type { RangeStroke, RangeStrokeMeasurement } from '../api/types';

const strokes = fixtures as unknown as RangeStroke[];
const four = strokes.find((s) => s.club === '4Iron')!.proBall!;

const D2R = Math.PI / 180;
const radial = (side: number, forward: number) => Math.sqrt(side ** 2 + forward ** 2);

describe('applyBayOffset is a rotation about the tee', () => {
  /**
   * The defining property, and the one the previous implementation broke: a
   * rotation moves the landing point around the tee, so its distance from the
   * tee cannot change. The old code held `forward` fixed and took
   * forward·tan(finish − offset), which quietly pushed the point onto a
   * different radius.
   */
  it('preserves the radial carry distance', () => {
    for (const offset of [-19, -5, 0, 5, 16, 19]) {
      const a = applyBayOffset(four, offset);
      expect(radial(a.carrySide!, a.carryForward!)).toBeCloseTo(four.carry!, 9);
    }
  });

  it('rotates the finish angle by exactly the offset', () => {
    const forward = Math.sqrt(four.carry! ** 2 - four.carrySide! ** 2);
    const finish = Math.atan2(four.carrySide!, forward);
    const a = applyBayOffset(four, 16);
    expect(Math.atan2(a.carrySide!, a.carryForward!)).toBeCloseTo(finish - 16 * D2R, 12);
  });

  /**
   * Regression guard on the exact numbers. forward·tan(θ) gives 11.71 m here —
   * 6% short — and the error scales with the bay's offset, so bays corrected by
   * different amounts had incomparable dispersion.
   */
  it('does not shrink the corrected side the way forward·tan did', () => {
    const a = applyBayOffset(four, 16);
    expect(a.carrySide!).toBeCloseTo(12.460182, 5);
    expect(a.carryForward!).toBeCloseTo(160.322598, 5);
    const forward = Math.sqrt(four.carry! ** 2 - four.carrySide! ** 2);
    const old = forward * Math.tan(Math.atan2(four.carrySide!, forward) - 16 * D2R);
    expect(old).toBeLessThan(a.carrySide!);
  });

  it('reports the forward component even with no offset to apply', () => {
    const a = applyBayOffset(four, undefined);
    expect(a.corrected).toBe(false);
    expect(a.carrySide).toBe(four.carrySide);
    // Radial carry is 160.8 m but the ball landed 56 m offline, so it only got
    // 150.7 m down the range.
    expect(a.carryForward!).toBeCloseTo(150.68, 1);
    expect(a.carryForward!).toBeLessThan(four.carry!);
  });
});

describe('offset estimation', () => {
  const measurement = (launchDirection: number): RangeStrokeMeasurement =>
    ({ ...four, launchDirection }) as RangeStrokeMeasurement;

  const stroke = (
    bay: string,
    targetId: string,
    launchDirection: number,
    club = '6Iron',
    positions: Partial<RangeStroke> = {},
  ): RangeStroke =>
    ({
      ...strokes[0],
      club,
      bayName: bay,
      targetId,
      proBall: measurement(launchDirection),
      ...positions,
    }) as RangeStroke;

  const allClean = () => true;

  it('uses the measured median once the group is big enough', () => {
    const dirs = [10, 11, 12, 13, 14, 15, 16, 17, 18];
    const offsets = computeBayOffsets(
      dirs.map((d) => stroke('BAY16', 'tgt-1', d)),
      allClean,
    );
    const o = offsets.get(offsetKey('BAY16', 'tgt-1'))!;
    expect(o.source).toBe('measured');
    expect(o.offsetDeg).toBe(14);
    expect(o.n).toBe(9);
  });

  /**
   * A group below the minimum used to get no correction at all, and its shots
   * were then plotted alongside corrected ones with no indication. At a 19° bay
   * that is a ~60 yard outlier dragging the ellipse centre. Geometry needs no
   * shots, so use it.
   */
  it('falls back to geometry when the group is too small to measure', () => {
    const positions = {
      teePosition: [0, 0, 0],
      targetPosition: [100, 0, -20],
    };
    const offsets = computeBayOffsets(
      [10, 12].map((d) => stroke('BAY07', 'tgt-A', d, '6Iron', positions)),
      allClean,
    );
    const o = offsets.get(offsetKey('BAY07', 'tgt-A'))!;
    expect(o.source).toBe('geometric');
    expect(o.n).toBe(2);
    // atan2(-20, 100) = -11.31°, negated into the launch-direction convention.
    expect(o.offsetDeg).toBeCloseTo(11.31, 2);
    expect(o.residualDeg).toBeNull();
  });

  it('drops a group that can be neither measured nor predicted', () => {
    const offsets = computeBayOffsets([stroke('BAY99', 'tgt-Z', 10)], allClean);
    expect(offsets.has(offsetKey('BAY99', 'tgt-Z'))).toBe(false);
  });

  it('prefers the tee over the bay centre when both are known', () => {
    const positions = {
      teePosition: [0, 0, 0],
      bayPosition: [0, 0, 40],
      targetPosition: [100, 0, 0],
    };
    const offsets = computeBayOffsets(
      [10, 12].map((d) => stroke('BAY07', 'tgt-A', d, '6Iron', positions)),
      allClean,
    );
    // From the tee the target is dead ahead; from the bay centre it would read
    // as 21.8°.
    expect(offsets.get(offsetKey('BAY07', 'tgt-A'))!.offsetDeg).toBeCloseTo(0, 9);
  });

  /**
   * The residual is the only survivor of the player's real directional bias:
   * subtracting a group's own median forces that median to zero, so nothing
   * downstream can show it.
   */
  it('reports the measured offset’s gap from straight out of the bay', () => {
    const positions = {
      teePosition: [0, 0, 0],
      // atan2(-20, 100) = -11.31 -> geometric offset +11.31
      targetPosition: [100, 0, -20],
    };
    const dirs = [12, 13, 14, 15, 16, 17, 18, 19, 20];
    const offsets = computeBayOffsets(
      dirs.map((d) => stroke('BAY16', 'tgt-1', d, '6Iron', positions)),
      allClean,
    );
    const o = offsets.get(offsetKey('BAY16', 'tgt-1'))!;
    expect(o.offsetDeg).toBe(16);
    expect(o.geometricDeg).toBeCloseTo(11.31, 2);
    expect(o.residualDeg).toBeCloseTo(4.69, 2);
  });

  it('counts the clubs behind a measured offset', () => {
    const dirs = [10, 11, 12, 13, 14, 15, 16, 17, 18];
    const offsets = computeBayOffsets(
      dirs.map((d, i) => stroke('BAY16', 'tgt-1', d, i < 3 ? '6Iron' : '4Iron')),
      allClean,
    );
    expect(offsets.get(offsetKey('BAY16', 'tgt-1'))!.clubs).toBe(2);
  });

  it('excludes mishits from the median but still counts the group', () => {
    const dirs = [10, 11, 12, 13, 14, 15, 16, 17, 18];
    const clean = (m: RangeStrokeMeasurement) => (m.launchDirection ?? 0) < 90;
    const offsets = computeBayOffsets(
      [...dirs, 200, 200].map((d) => stroke('BAY16', 'tgt-1', d)),
      clean,
    );
    const o = offsets.get(offsetKey('BAY16', 'tgt-1'))!;
    expect(o.n).toBe(9);
    expect(o.offsetDeg).toBe(14);
  });
});
