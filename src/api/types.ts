/**
 * Types mirroring the Trackman GraphQL schema, as discovered empirically in
 * Phase 0. See phase0/raw/02_schema.json for the full introspection dump.
 *
 * Everything here describes RangeStroke / RangeStrokeMeasurement — the outdoor
 * Trackman Range path. This is a DIFFERENT type from the Stroke /
 * ShotMeasurement path used by simulator activities, and it carries no
 * club-delivery data at all.
 */

/** Which measurement variant to request. Discovered from the schema. */
export type RangeMeasurementType =
  | 'MEASUREMENT'
  | 'SITE_MEASUREMENT'
  | 'PRO_BALL_MEASUREMENT'
  | 'PRO_BALL_SITE_MEASUREMENT';

/**
 * The variant the TrackMan phone app displays. Validated in Phase 0 against
 * two known shots — matched carry/ball speed/launch/peak/direction/side to
 * within rounding. Store this one as the canonical view.
 */
export const APP_MEASUREMENT: RangeMeasurementType = 'PRO_BALL_MEASUREMENT';

/**
 * Raw range-ball numbers, unnormalized. Identical to the default (no-arg)
 * measurement. Kept so we can always tell normalized from raw.
 */
export const RAW_MEASUREMENT: RangeMeasurementType = 'SITE_MEASUREMENT';

/**
 * All distances metres, speeds m/s, angles degrees.
 *
 * The `*Actual` variants are a separate normalization axis from
 * measurementType: they adjust for the day's conditions, where measurementType
 * adjusts for ball construction. The app shows the plain (non-Actual) fields.
 *
 * Notable absences, confirmed against the introspected schema: clubSpeed,
 * clubPath, faceAngle, attackAngle, dynamicLoft, smashFactor. Ball tracking
 * only — do not add fields here without checking the dump.
 */
export interface RangeStrokeMeasurement {
  id: string;
  kind: string | null;
  time: string | null;

  carry: number | null;
  carryActual: number | null;
  total: number | null;
  totalActual: number | null;

  carrySide: number | null;
  carrySideActual: number | null;
  totalSide: number | null;
  totalSideActual: number | null;

  ballSpeed: number | null;
  ballSpin: number | null;
  ballSpinEffective: number | null;
  spinAxis: number | null;

  launchAngle: number | null;
  launchDirection: number | null;
  landingAngle: number | null;
  maxHeight: number | null;
  hangTime: number | null;

  /**
   * Signed lateral deviation from the LAUNCH line, in metres. Positive = right.
   * Already alignment-independent — this is the curvature metric, and it is
   * strictly better than deriving one from launchDirection + carrySide.
   */
  curve: number | null;
  curveActual: number | null;
  curveTotal: number | null;

  targetDistance: number | null;
  distanceFromPin: number | null;

  /**
   * Per-metric quality warnings, e.g. 'PotentialGhost', 'SpinRateFit'.
   * Varies by measurementType — the PRO_BALL variant reports far fewer.
   */
  reducedAccuracy: string[] | null;

  /**
   * WARNING: false on all 412 strokes in the Phase 0 dump. Despite the name it
   * is not a usable quality signal. Do not filter on it.
   */
  isValidMeasurement: boolean | null;

  ballVelocity: number[] | null;
}

export interface RangeStroke {
  time: string;
  club: string | null;
  dbId: string;
  bayName: string | null;
  bayType: string | null;
  bayPosition: number[] | null;
  targetPosition: number[] | null;
  targetId: string | null;
  teePosition: number[] | null;
  isSimulated: boolean | null;
  isDeleted: boolean | null;
  /** Normalized/pro-ball view — what the app shows. */
  proBall: RangeStrokeMeasurement | null;
  /** Raw range-ball view, for comparison. */
  raw: RangeStrokeMeasurement | null;
}

export interface RangeActivity {
  id: string;
  time: string;
  numberOfStrokes: number | null;
  /**
   * Hidden sessions are excluded unless the query passes includeHidden: true.
   * Captured so the UI can show that a session was hidden rather than pretending
   * it is like any other.
   */
  isHidden: boolean | null;
  location: { name: string | null } | null;
}

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  scope?: string;
  /** Absolute epoch ms when the access token expires. Computed on receipt. */
  expires_at: number;
}

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}
