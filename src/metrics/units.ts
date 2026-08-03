/**
 * Unit conversion.
 *
 * The API is metric throughout: distances in metres, speeds in m/s, angles in
 * degrees. The phone app displays imperial. Every number that reaches the UI
 * goes through here — do not convert ad hoc at call sites.
 */

export const M_TO_YD = 1.0936133;
export const M_TO_FT = 3.2808399;
export const MS_TO_MPH = 2.2369363;

export const toYards = (m: number | null | undefined): number | null =>
  m == null ? null : m * M_TO_YD;

export const toFeet = (m: number | null | undefined): number | null =>
  m == null ? null : m * M_TO_FT;

export const toMph = (ms: number | null | undefined): number | null =>
  ms == null ? null : ms * MS_TO_MPH;

export const round = (v: number | null | undefined, dp = 1): number | null =>
  v == null ? null : Math.round(v * 10 ** dp) / 10 ** dp;
