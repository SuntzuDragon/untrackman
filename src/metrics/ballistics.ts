/**
 * Expected carry from ball flight.
 *
 * Why this exists: the strike classifier grades on ball speed and launch angle
 * alone, which lets a badly struck shot through whenever the speed happens to
 * clear the bar. A real example from this account — a 6-iron at 98 mph ball
 * speed that carried 40 yards — was graded a clean strike.
 *
 * Rather than hardcode a physics model with drag and lift coefficients we would
 * have no way to calibrate, this fits a quadratic surface to the player's OWN
 * well-struck shots. Carry is overwhelmingly determined by ball speed, launch
 * angle and spin, and none of that depends on which club was used, so one model
 * is fitted across the whole bag.
 *
 * A shot that flies materially shorter than its own launch conditions predict
 * did something the numbers do not otherwise show — usually a glancing strike
 * that produced speed without a stable flight.
 */

import { M_TO_YD, MS_TO_MPH } from './units';
import type { RangeStrokeMeasurement } from '../api/types';

/**
 * Design row. Quadratic in speed and launch because carry is not linear in
 * either: doubling launch angle from 10° to 20° adds carry, from 30° to 40°
 * removes it.
 */
function features(ballMph: number, launchDeg: number, spinRpm: number | null): number[] {
  const spin = (spinRpm ?? 4000) / 1000;
  return [
    1,
    ballMph,
    ballMph * ballMph,
    launchDeg,
    launchDeg * launchDeg,
    ballMph * launchDeg,
    spin,
  ];
}

/** Solve (XᵀX)b = Xᵀy by Gaussian elimination with partial pivoting. */
function solveLeastSquares(X: number[][], y: number[]): number[] | null {
  const k = X[0].length;
  const A: number[][] = Array.from({ length: k }, () => new Array(k + 1).fill(0));

  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      let sum = 0;
      for (let r = 0; r < X.length; r++) sum += X[r][i] * X[r][j];
      A[i][j] = sum;
    }
    let sum = 0;
    for (let r = 0; r < X.length; r++) sum += X[r][i] * y[r];
    A[i][k] = sum;
    // Ridge term: keeps the system solvable when features are near-collinear,
    // which they are (ballMph and ballMph² move together).
    A[i][i] += 1e-6;
  }

  for (let col = 0; col < k; col++) {
    let pivot = col;
    for (let r = col + 1; r < k; r++) {
      if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
    }
    if (Math.abs(A[pivot][col]) < 1e-12) return null;
    [A[col], A[pivot]] = [A[pivot], A[col]];
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let c = col; c <= k; c++) A[r][c] -= f * A[col][c];
    }
  }
  return A.map((row, i) => row[k] / A[i][i]);
}

export interface CarryModel {
  coefficients: number[];
  /** Fraction of carry variance the model explains on the training shots. */
  r2: number;
  /** Shots used to fit. */
  n: number;
  predict(ballMph: number, launchDeg: number, spinRpm: number | null): number;
}

/** Minimum well-struck shots before the fit is trustworthy. */
const MIN_TRAINING_SHOTS = 40;

/**
 * Fit the model on shots that are already confidently well struck.
 *
 * `isWellStruck` should be conservative — training on mishits would teach the
 * model that a topped 6-iron is normal and defeat the whole purpose.
 */
export function fitCarryModel(
  measurements: RangeStrokeMeasurement[],
  isWellStruck: (m: RangeStrokeMeasurement) => boolean,
): CarryModel | null {
  const X: number[][] = [];
  const y: number[] = [];

  for (const m of measurements) {
    if (m.ballSpeed == null || m.launchAngle == null || m.carry == null) continue;
    if (!isWellStruck(m)) continue;
    X.push(features(m.ballSpeed * MS_TO_MPH, m.launchAngle, m.ballSpin));
    y.push(m.carry * M_TO_YD);
  }
  if (X.length < MIN_TRAINING_SHOTS) return null;

  const b = solveLeastSquares(X, y);
  if (!b) return null;

  const my = y.reduce((a, c) => a + c, 0) / y.length;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < X.length; i++) {
    const pred = X[i].reduce((a, v, j) => a + v * b[j], 0);
    ssRes += (y[i] - pred) ** 2;
    ssTot += (y[i] - my) ** 2;
  }

  return {
    coefficients: b,
    r2: ssTot === 0 ? 0 : 1 - ssRes / ssTot,
    n: X.length,
    predict(ballMph, launchDeg, spinRpm) {
      return features(ballMph, launchDeg, spinRpm).reduce(
        (a, v, j) => a + v * b[j],
        0,
      );
    },
  };
}

/**
 * Carry efficiency: actual carry as a fraction of what these launch conditions
 * should have produced.
 *
 * ~1.0 is a normal strike. Below ~0.85 the ball left the face with the speed
 * and angle of a good shot but did not fly like one.
 */
export function carryEfficiency(
  m: RangeStrokeMeasurement,
  model: CarryModel | null,
): { expectedYd: number | null; efficiency: number | null } {
  if (!model || m.ballSpeed == null || m.launchAngle == null || m.carry == null) {
    return { expectedYd: null, efficiency: null };
  }
  const expected = model.predict(m.ballSpeed * MS_TO_MPH, m.launchAngle, m.ballSpin);
  if (expected <= 5) return { expectedYd: expected, efficiency: null };
  return { expectedYd: expected, efficiency: (m.carry * M_TO_YD) / expected };
}
