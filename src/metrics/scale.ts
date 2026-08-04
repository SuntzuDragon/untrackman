/**
 * Axis bounds derived from the values actually being plotted.
 *
 * Two failure modes motivate this, and they are the same bug wearing different
 * hats. Observable Plot's default quantitative domain is the exact extent of
 * the data, so the highest point sits on the frame and reads as cut off. A
 * hardcoded domain — [0, 100] for a mishit rate that never exceeds 30% —
 * throws away two thirds of the panel and flattens every movement in it.
 *
 * Both are fixed by computing the domain from the numbers: pad by a fraction
 * of the data's own range so nothing touches the frame, then round outward to
 * a readable step so the axis ticks land on numbers a human would pick.
 */

/** Steps a person would choose for an axis, per decade. */
const NICE_STEPS = [1, 2, 2.5, 5, 10];

/** Smallest "round" number at or above `rough`. */
export function niceStep(rough: number): number {
  if (!(rough > 0)) return 1;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  for (const s of NICE_STEPS) if (norm <= s) return s * mag;
  return 10 * mag;
}

/** Kill the 0.30000000000000004 that floor/ceil-by-step produces. */
const clean = (v: number) => (v === 0 ? 0 : Number(v.toPrecision(12)));

/**
 * Round `value` away from the data to a readable number, spending at most
 * `slop` doing it. Coarsest step first — a domain ending on 150 beats one
 * ending on 148 — then progressively finer until one fits.
 */
function roundOut(value: number, span: number, dir: 1 | -1, slop: number): number {
  for (const div of [5, 10, 20, 50]) {
    const step = niceStep(span / div);
    const r = dir > 0 ? Math.ceil(value / step) * step : Math.floor(value / step) * step;
    if (Math.abs(r - value) <= slop) return r;
  }
  return value;
}

export interface BoundsOptions {
  /** Headroom at each end, as a fraction of the data range. Default 0.06. */
  pad?: number;
  padMax?: number;
  padMin?: number;
  /** Values the domain must cover even if nothing is plotted there. */
  include?: readonly number[];
  /**
   * Hard floor/ceiling. Only applied when the data does not already cross it —
   * padding must never hide a real value. Defaults: a series that is entirely
   * non-negative gets a floor of 0, because padding a rate down to -3% invents
   * territory the quantity cannot occupy.
   */
  min?: number;
  max?: number;
  /** Round the ends outward to a readable step. Default true. */
  round?: boolean;
}

/**
 * Domain for a quantitative axis, or undefined when there is nothing to plot
 * (in which case leave the scale off the spec and let Plot decide).
 *
 * Pass values in the units the axis renders in — for a `percent: true` scale
 * that means 0–100, not 0–1.
 */
export function axisBounds(
  values: Iterable<number | null | undefined>,
  opts: BoundsOptions = {},
): [number, number] | undefined {
  let lo = Infinity;
  let hi = -Infinity;
  const see = (v: number | null | undefined) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  };
  for (const v of values) see(v);
  for (const v of opts.include ?? []) see(v);
  if (lo === Infinity) return undefined;

  // A flat series still needs a window around it, sized off the value itself.
  const span = hi > lo ? hi - lo : Math.abs(hi) * 0.1 || 1;

  const padMax = opts.padMax ?? opts.pad ?? 0.06;
  const padMin = opts.padMin ?? opts.pad ?? 0.06;
  let bottom = lo - span * padMin;
  let top = hi + span * padMax;

  if (opts.round !== false) {
    // Round out to the coarsest step that does not more than double the
    // headroom. Snapping to a single fixed step is what produces an axis whose
    // top sits a whole tick above anything plotted; falling back through finer
    // steps keeps the end round *and* the gap tiny.
    bottom = roundOut(bottom, span, -1, span * padMin);
    top = roundOut(top, span, 1, span * padMax);
  }

  const min = opts.min ?? 0;
  if (lo >= min && bottom < min) bottom = min;
  if (opts.max != null && hi <= opts.max && top > opts.max) top = opts.max;

  return [clean(bottom), clean(top)];
}
