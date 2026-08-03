/**
 * GraphQL documents. Field selections come from the Phase 0 introspection dump
 * (phase0/raw/02_schema.json) — every field here was verified to exist and to
 * return data on a real RangePracticeActivity.
 */

/**
 * All scalar fields on RangeStrokeMeasurement. Shared between the pro-ball and
 * raw selections so the two views are always directly comparable.
 */
const MEASUREMENT_FIELDS = `
  id kind time
  carry carryActual total totalActual
  carrySide carrySideActual totalSide totalSideActual
  ballSpeed ballSpin ballSpinEffective spinAxis
  launchAngle launchDirection landingAngle maxHeight hangTime
  curve curveActual curveTotal
  targetDistance distanceFromPin
  reducedAccuracy isValidMeasurement ballVelocity
`;

/**
 * Range sessions only.
 *
 * IMPORTANT: `includeHidden: true` is required. Without it the API silently
 * omits hidden sessions — this account had one (2026-06-17, 38 strokes) that
 * never appeared, and because it was the EARLIEST session its absence skewed
 * every since-first-session comparison. There is no indication in the response
 * that anything was withheld.
 *
 * `timeFrom` / `timeTo` also exist but are not needed: with includeHidden and
 * no date bounds the API returns the account's full history.
 *
 * Outdoor Trackman Range sessions are RANGE_PRACTICE, *not*
 * VIRTUAL_RANGE. VIRTUAL_RANGE is the indoor simulator feature and returns an
 * empty set for a range-only account — which looks exactly like "the API
 * doesn't expose range data". Verified in Phase 0: 7/7 sessions were
 * RangePracticeActivity.
 */
export const ACTIVITIES = `
  query RangeActivities($take: Int!, $skip: Int!) {
    me {
      activities(take: $take, skip: $skip, kinds: [RANGE_PRACTICE], includeHidden: true) {
        totalCount
        pageInfo { hasNextPage }
        items {
          __typename
          ... on RangePracticeActivity {
            id
            time
            numberOfStrokes
            isHidden
            location { name }
          }
        }
      }
    }
  }
`;

/**
 * Strokes for one session, in both measurement variants.
 *
 * PRO_BALL_SITE_MEASUREMENT is deliberately omitted — it was null on all 412
 * strokes in the Phase 0 dump. The default (no-arg) measurement is byte
 * identical to SITE_MEASUREMENT, so requesting SITE explicitly is enough.
 */
export const STROKES = `
  query SessionStrokes($id: ID!) {
    node(id: $id) {
      __typename
      ... on RangePracticeActivity {
        id
        time
        strokes {
          time club dbId
          bayName bayType bayPosition
          targetPosition targetId teePosition
          isSimulated isDeleted
          proBall: measurement(measurementType: PRO_BALL_MEASUREMENT) { ${MEASUREMENT_FIELDS} }
          raw:     measurement(measurementType: SITE_MEASUREMENT)     { ${MEASUREMENT_FIELDS} }
        }
      }
    }
  }
`;

export const PROFILE = `
  query Profile {
    me { profile { id fullName email } }
  }
`;
