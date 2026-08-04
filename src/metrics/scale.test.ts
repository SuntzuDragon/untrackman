import { describe, expect, it } from 'vitest';
import { axisBounds, niceStep } from './scale';

describe('niceStep', () => {
  it('snaps up to a round step', () => {
    expect(niceStep(0.9)).toBe(1);
    expect(niceStep(1.4)).toBe(2);
    expect(niceStep(2.2)).toBe(2.5);
    expect(niceStep(3)).toBe(5);
    expect(niceStep(37)).toBe(50);
    expect(niceStep(0.012)).toBe(0.02);
  });
});

describe('axisBounds', () => {
  it('leaves headroom so the extremes never sit on the frame', () => {
    const [lo, hi] = axisBounds([120, 135, 148])!;
    expect(lo).toBeLessThan(120);
    expect(hi).toBeGreaterThan(148);
  });

  it('does not waste the panel — the window tracks the data range', () => {
    // The bug this replaces: a 5-30% rate drawn on a fixed 0-100 axis used a
    // quarter of the height. The padded window must stay close to the data.
    const [lo, hi] = axisBounds([5, 12, 30])!;
    expect(hi).toBeLessThanOrEqual(40);
    expect(lo).toBeGreaterThanOrEqual(0);
  });

  it('floors a non-negative series at zero instead of padding below it', () => {
    expect(axisBounds([0, 4, 9])![0]).toBe(0);
  });

  it('keeps negative values visible rather than clipping to the floor', () => {
    const [lo, hi] = axisBounds([-14, -3, 22])!;
    expect(lo).toBeLessThan(-14);
    expect(hi).toBeGreaterThan(22);
  });

  it('honours a ceiling only when the data stays under it', () => {
    expect(axisBounds([40, 96], { max: 100 })![1]).toBe(100);
    // Strike quality can exceed 100% of expected; clipping there would hide it.
    expect(axisBounds([90, 118], { max: 100 })![1]).toBeGreaterThan(118);
  });

  it('covers included values that nothing is plotted at', () => {
    const [lo, hi] = axisBounds([8, 19], { include: [0] })!;
    expect(lo).toBe(0);
    expect(hi).toBeGreaterThan(19);
  });

  it('opens a window around a flat series', () => {
    const [lo, hi] = axisBounds([7, 7, 7])!;
    expect(lo).toBeLessThan(7);
    expect(hi).toBeGreaterThan(7);
  });

  it('returns undefined when there is nothing to plot', () => {
    expect(axisBounds([])).toBeUndefined();
    expect(axisBounds([null, undefined, NaN])).toBeUndefined();
  });

  it('ends on tidy numbers without paying much for it', () => {
    const [lo, hi] = axisBounds([103.7, 148.2])!;
    expect(lo % 2.5).toBe(0);
    expect(hi % 2.5).toBe(0);
    // Rounding may spend at most the padding again, so the top stays close to
    // the data instead of jumping a whole tick clear of it.
    expect(hi - 148.2).toBeLessThan(0.13 * (148.2 - 103.7));
  });
});
