# untrackman

[![CI](https://github.com/SuntzuDragon/untrackman/actions/workflows/ci.yml/badge.svg)](https://github.com/SuntzuDragon/untrackman/actions/workflows/ci.yml)
[![deploy](https://img.shields.io/github/checks-status/SuntzuDragon/untrackman/main?label=deploy)](https://github.com/SuntzuDragon/untrackman/commits/main)
[![live](https://img.shields.io/badge/live-golf.imcb.dev-f38020?logo=cloudflare&logoColor=white)](https://golf.imcb.dev)

Your Trackman Range shot data, extracted and analysed across sessions.

The TrackMan consumer app has no export, and the web portal walls per-shot detail
behind a "download the app" message. This pulls it out and charts it over time —
something Trackman doesn't offer at any tier.

**No backend. No database. No server.** A static SPA that talks to Trackman's
GraphQL API directly from the browser and stores shots in IndexedDB. Deploys to
any static host for free.

> **Unofficial.** Not affiliated with, endorsed by, or supported by Trackman.
> It uses a private API that carries no stability guarantee and may change or
> break without notice. Built for personal use against my own account and my
> own data. Don't point it at anyone else's, don't run it at volume, and leave
> the request throttle alone.

---

## Running it

```bash
pnpm install
pnpm dev           # http://localhost:5173
pnpm build         # -> dist/, deploy anywhere static
pnpm test          # regression tests against real validated shots
pnpm deploy        # build + push to Cloudflare Workers
```

Live at **https://golf.imcb.dev**, on Cloudflare Workers Static Assets
(`wrangler.jsonc`). There is no `main` entry, so no Worker code runs — it is
purely static files on a CDN. Adding a `main` later would make it full-stack
without changing hosts or DNS.

Pushes to `main` build and deploy automatically. CI runs typecheck, the
regression suite, and the build; Cloudflare's own build only does typecheck and
bundle, which is why the tests run separately.

Sign in with the QR code, hit **Sync**, done.

---

## How the auth works

OAuth2 **device authorization grant** against `login.trackmangolf.com`.

We can't register a redirect URI with Trackman's IdP, so authorization-code +
PKCE is unavailable. The device grant needs no redirect URI at all, which
sidesteps the problem entirely — and it's the better UX on a phone anyway: scan
a QR, approve on Trackman's own domain, done.

- Client: `old-golf-app.c686e909-…` — the legacy range app. **The portal's own
  client (`golf-portal.*`) rejects the device grant** with `invalid_client`.
- Scopes: `openid profile offline_access https://auth.trackman.com/dr/cloud`.
  `dr/cloud` is what the GraphQL API actually checks; `offline_access` gets the
  refresh token.
- Access tokens last 14 days and refresh silently, so you sign in roughly once.

Both auth endpoints send `access-control-allow-origin: *`, and the GraphQL API
reflects whatever `Origin` you send it. That's why no proxy is needed.

### Tradeoff you should know about

Tokens live in `localStorage` on a public origin. This is the standard posture
for a PKCE SPA, and the tokens are scoped to your own read-only golf data — but
it is a real tradeoff, and the alternative is a backend. Chosen deliberately.

---

## Things that were not obvious

These cost real time to establish. Changing any of them without re-validating
will silently corrupt the numbers.

### Range sessions are `RANGE_PRACTICE`, not `VIRTUAL_RANGE`

Outdoor Trackman Range sessions come back as `RangePracticeActivity`.
`VIRTUAL_RANGE` is the indoor simulator feature. Filtering on `VIRTUAL_RANGE`
returns an empty set for a range-only account — which looks exactly like "the
API doesn't expose range data."

The stroke type is `RangeStroke` → `RangeStrokeMeasurement`, a **different type**
from the `Stroke` / `ShotMeasurement` path that all the public prior art uses.

### The app displays `PRO_BALL_MEASUREMENT`

`measurement(measurementType:)` takes four values:

| Variant | Notes |
|---|---|
| `MEASUREMENT` | Raw, radar/bay reference frame |
| `SITE_MEASUREMENT` | Raw, site reference frame. Identical to the no-arg default |
| `PRO_BALL_MEASUREMENT` | **Normalized to a premium ball — what the phone app shows** |
| `PRO_BALL_SITE_MEASUREMENT` | `null` on all 412 strokes |

Validated against two shots read off the app; both matched to rounding. Raw and
pro-ball differ by ~2.8 m of carry and ~69 rpm, so they are not interchangeable.
Both are stored per stroke.

Separately, the `*Actual` fields (`carryActual`, `carrySideActual`, …) are a
**different** normalization axis — conditions, not ball construction. The app
shows the plain fields.

**Pro-ball nulls three fields that site populates.** Across all 412 strokes:

| Field | on `PRO_BALL` | on `SITE` |
|---|---|---|
| `landingAngle` | 0/412 | 412/412 |
| `ballSpinEffective` | 0/412 | 412/412 |
| `reducedAccuracy` | 0/412 | 412/412 |

So you cannot simply prefer the pro-ball object — doing that silently drops all
three. `mergeMeasurement()` back-fills exactly those three fields and nothing
else, because they are geometry and flags rather than normalized measurements;
back-filling `carry` would mix normalization bases and corrupt every distance.

### There is no club data, and no smash factor

`RangeStrokeMeasurement` has no `clubSpeed`, `clubPath`, `faceAngle`,
`attackAngle`, or `dynamicLoft` — ball tracking only. It also has no
`smashFactor`, so the estimated club speed in the UI has nothing to check
itself against. It is labelled as an estimate everywhere it appears.

Spin *is* present — `ballSpin`, `ballSpinEffective`, `spinAxis` — but roughly
half of it is **modelled, not measured**. The `reducedAccuracy` array carries a
`SpinRateFit` flag on 198 of 412 strokes, meaning spin was fitted from the ball
flight rather than resolved directly; outdoor radar often cannot read dimples at
distance. Treat per-shot spin as soft. Club-level medians are still useful.

### Curvature is already provided, and the obvious formula has the sign backwards

`curve` is signed lateral deviation from the **launch line** in metres, positive
right. Because it is measured off the launch line rather than the target line it
is already independent of bay alignment.

Deriving it by hand as `launchDirection − finishAngle` returns **positive for a
draw**. A validated 6-iron started 10.92° right and finished 1.39° right — it
moved left — yet that formula yields +9.53. Native `curve` (−24.1 m) and
`spinAxis` (−19.65, left tilt) both agree it is a draw. Correlation across 232
shots: **−0.968**. There is a regression test pinning this.

### Launch direction is measured against the bay→target line

Not against the bay's axis, and not against north. If you aim anywhere other
than the selected target — for instance simply hitting straight out of the bay —
every shot picks up a constant offset equal to the angle between your aim and
that line.

This is geometry, not a swing pattern, and `bayPosition` / `targetPosition` let
you prove it: the angle derived from those coordinates correlates with the
measured median launch direction at **r = −0.99** across this account's eight
(bay, target) combinations.

Two consequences:

- **Key the offset on (bay, target), not bay.** One bay hosts several targets.
  In this data BAY07's two targets differ by 11.8°; collapsing them to one
  per-bay number is wrong for both.
- **Use the empirical median, not the raw geometry.** Regressing measured
  direction against the pure "hit dead straight out of the bay" prediction gives
  slope 0.71 (r = 0.96) — this player aims about 29% of the way toward the
  selected target without intending to. Raw geometry would over-correct by that
  same 29%; the median absorbs it.

`curve` needs no correction — it is measured off the launch line, so applying
one would double-count. There is a test asserting this.

### `isValidMeasurement` is useless

`false` on all 412 strokes. Despite the name it is not a quality signal. Don't
filter on it. Use `reducedAccuracy` (which varies by measurement variant) or the
ball-speed heuristic in `metrics/shot.ts`.

### `MEASUREMENT` and `SITE_MEASUREMENT` use different reference frames

They differ in `launchDirection` by a median of 10.88°. Don't mix them; this
project reads direction from the pro-ball view throughout.

---

## Layout

```
src/
  api/       device-flow auth, GraphQL transport, queries, types
  db/        Dexie schema + idempotent sync
  metrics/   units, club config, per-shot derivations, aggregation
  ui/        login, chart wrapper
```

Sync is idempotent — strokes are keyed on the API's own `dbId`, and sessions
whose stroke count already matches are skipped.

Requests are serialised and paced at 350 ms. This is an unofficial private API
for personal use; don't remove the throttle.

---

## Re-deriving any of this

Everything above was established empirically against a live account. If Trackman
changes the schema, the way to re-check is introspection — it is enabled:

```bash
curl -s https://api.trackmangolf.com/graphql \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"query":"{ __type(name:\"RangeStrokeMeasurement\"){ fields { name type { kind name } } } }"}'
```

Useful entry points: `ActivityKind` for the activity enum,
`RangeMeasurementTypes` for the measurement variants, and `__schema.types` for
everything. The regression tests in `src/metrics/shot.test.ts` pin the two
validated shots, so a schema change that alters the numbers will fail the suite
rather than silently skew the charts.

## Club config

Lofts live in `src/metrics/clubs.ts` and drive the launch-vs-loft analysis.

| Club | Model | Loft | Confidence |
|---|---|---|---|
| Driver | Callaway RAZR Fit Xtreme | 10.5° | adjustable hosel — confirm your setting |
| 4 Iron | Mizuno MP-63 | 24° | verified |
| 5 Iron | Mizuno MP-62 | 27° | verified |
| 6 Iron | Mizuno MP-62 | 31° | verified |
| 8 Iron | Mizuno MP-63 | 38° | verified |
| 9 Iron | Mizuno JPX 900 | 41° | **assumed** — Forged 41°, Tour 42°, Hot Metal 37° |
| PW | Mizuno MP-63 | 46° | verified, unused at the range |

No 7-iron. 6i 31° → 8i 38° is a 7° gap where the rest of the set steps 3–5°,
which the gapping view calls out explicitly.
