import { useCallback, useEffect, useMemo, useState } from 'react';
import * as Plot from '@observablehq/plot';
import { Login } from './ui/Login';
import { Chart } from './ui/Chart';
import { loadTokens, clearTokens } from './api/auth';
import { db, clearAll } from './db/db';
import { sync, type SyncProgress } from './db/sync';
import { toShot, referenceSpeeds, loftBaselines, type Shot } from './metrics/shot';
import { computeBayOffsets, makeCleanStrikePredicate, type BayOffset } from './metrics/bays';
import {
  clubStats, gapping, sessionTrends, dispersionEllipse, toCsv,
  TREND_METRICS, MIN_SHOTS_FOR_TREND, trendFit, fatigueCurve,
} from './metrics/stats';
import { ClubFilter, loadClubFilter, saveClubFilter } from './ui/ClubFilter';
import {
  MISSING_SLOTS, clubLabel, clubOrder, getBag, setBag, loadBag, saveBag, resetBag,
  type ClubConfig,
} from './metrics/clubs';
import { BagEditor } from './ui/BagEditor';
import { fitCarryModel } from './metrics/ballistics';
import type { RangeStroke } from './api/types';

type Tab = 'overview' | 'clubs' | 'gapping' | 'dispersion' | 'curve' | 'fatigue' | 'shots' | 'bag';

const fmt = (v: number | null | undefined, dp = 1) =>
  v == null ? '—' : v.toFixed(dp);
const pct = (v: number | null | undefined) =>
  v == null ? '—' : `${(v * 100).toFixed(0)}%`;

export default function App() {
  const [signedIn, setSignedIn] = useState(() => loadTokens() != null);
  const [shots, setShots] = useState<Shot[]>([]);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [goodOnly, setGoodOnly] = useState(true);
  const [bayCorrect, setBayCorrect] = useState(true);
  const [bays, setBays] = useState<BayOffset[]>([]);
  const [clubFilter, setClubFilter] = useState<Set<string> | null>(() => loadClubFilter());
  /**
   * Hidden sessions are excluded by default. Trackman lets you hide a session,
   * and people hide them for good reasons — this account's hidden session was
   * hit with the wrong club selected, so its labels are wrong and folding it in
   * corrupts every per-club number. Synced regardless so it stays available.
   */
  const [showHidden, setShowHidden] = useState(false);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [bag, setBagState] = useState<ClubConfig[]>(() => {
    const b = loadBag();
    setBag(b);
    return b;
  });
  const [modelInfo, setModelInfo] = useState<{ r2: number; n: number } | null>(null);
  const [metricKey, setMetricKey] = useState(TREND_METRICS[0].key);

  const reload = useCallback(async () => {
    const [strokeRows, sessions] = await Promise.all([
      db.strokes.toArray(),
      db.sessions.toArray(),
    ]);
    const sessionTime = new Map(sessions.map((s) => [s.id, s.time]));
    setHiddenIds(new Set(sessions.filter((s) => s.isHidden).map((s) => s.id)));
    const raws: RangeStroke[] = strokeRows.map((r) => r.raw);
    const refs = referenceSpeeds(raws);
    // Each bay has its own uncalibrated zero line — up to 19 deg apart.
    const offsets = computeBayOffsets(raws, makeCleanStrikePredicate(refs));
    const lofts = loftBaselines(raws, refs);
    setBays([...offsets.values()].sort((a, b) => a.offsetDeg - b.offsetDeg));

    // Fit expected-carry on shots that already look well struck, so the model
    // does not learn that a topped 6-iron is normal.
    const wellStruck = makeCleanStrikePredicate(refs);
    const trainingSet = raws
      .filter((r) => {
        const m = r.proBall ?? r.raw;
        return !!m && wellStruck(m, r.club);
      })
      .map((r) => (r.proBall ?? r.raw)!);
    const carryModel = fitCarryModel(trainingSet, () => true);
    setModelInfo(carryModel ? { r2: carryModel.r2, n: carryModel.n } : null);

    // Shot index within each session, ordered by stroke time.
    const bySession = new Map<string, typeof strokeRows>();
    for (const r of strokeRows) {
      if (!bySession.has(r.sessionId)) bySession.set(r.sessionId, []);
      bySession.get(r.sessionId)!.push(r);
    }
    const indexOf = new Map<string, number>();
    for (const rows of bySession.values()) {
      [...rows]
        .sort((a, b) => a.time.localeCompare(b.time))
        .forEach((r, i) => indexOf.set(r.id, i + 1));
    }

    setShots(
      strokeRows.map((r) =>
        toShot(r.raw, r.sessionId, refs, offsets, lofts, {
          sessionTime: sessionTime.get(r.sessionId) ?? r.time,
          shotIndex: indexOf.get(r.id) ?? 0,
          model: carryModel,
        }),
      ),
    );
  }, [bag]);

  useEffect(() => {
    if (signedIn) reload();
  }, [signedIn, reload]);

  const runSync = useCallback(
    async (force = false) => {
      setError(null);
      try {
        await sync({ force, onProgress: setProgress });
        await reload();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setProgress(null);
      }
    },
    [reload],
  );

  /** Clubs actually present in the data, in bag order. */
  const sessionScoped = useMemo(
    () => shots.filter((s) => showHidden || !hiddenIds.has(s.sessionId)),
    [shots, showHidden, hiddenIds],
  );

  const availableClubs = useMemo(() => {
    const seen = new Set(sessionScoped.map((s) => s.club).filter((c): c is string => !!c));
    return getBag().map((c) => c.trackmanId).filter((c) => seen.has(c));
  }, [sessionScoped]);

  const shotCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of sessionScoped) if (s.club) m.set(s.club, (m.get(s.club) ?? 0) + 1);
    return m;
  }, [sessionScoped]);

  // Default to every club once the data lands; respect a stored selection but
  // drop clubs that are no longer present.
  // An empty selection is legitimate — the user asked for it — so don't refill
  // it. Only fall back to "everything" when nothing has been chosen yet.
  const selectedClubs = useMemo(() => {
    if (!clubFilter) return new Set(availableClubs);
    return new Set([...clubFilter].filter((c) => availableClubs.includes(c)));
  }, [clubFilter, availableClubs]);

  const applyBag = useCallback((next: ClubConfig[]) => {
    setBag(next);
    saveBag(next);
    setBagState(next);
  }, []);

  const setClubs = useCallback((next: Set<string>) => {
    saveClubFilter(next);
    setClubFilter(next);
  }, []);

  /** Everything below derives from the club- and session-scoped set. */
  const scoped = useMemo(
    () =>
      shots.filter(
        (s) =>
          s.club &&
          selectedClubs.has(s.club) &&
          (showHidden || !hiddenIds.has(s.sessionId)),
      ),
    [shots, selectedClubs, showHidden, hiddenIds],
  );
  const hiddenShotCount = useMemo(
    () => shots.filter((s) => hiddenIds.has(s.sessionId)).length,
    [shots, hiddenIds],
  );

  const stats = useMemo(() => clubStats(scoped, goodOnly), [scoped, goodOnly]);
  const fatigue = useMemo(() => fatigueCurve(scoped), [scoped]);
  const gaps = useMemo(() => gapping(stats), [stats]);
  const trends = useMemo(() => sessionTrends(scoped), [scoped]);
  const metric = useMemo(
    () => TREND_METRICS.find((m) => m.key === metricKey) ?? TREND_METRICS[0],
    [metricKey],
  );
  const visible = useMemo(
    () => (goodOnly ? scoped.filter((s) => s.quality === 'good') : scoped),
    [scoped, goodOnly],
  );
  /** Lateral position to plot: bay-corrected unless the user opts out. */
  const sideOf = useCallback(
    (s: Shot) => (bayCorrect ? s.carrySideAdjFt : s.carrySideFt),
    [bayCorrect],
  );
  const dirOf = useCallback(
    (s: Shot) => (bayCorrect ? s.launchDirectionAdj : s.launchDirection),
    [bayCorrect],
  );

  if (!signedIn) return <Login onSignedIn={() => setSignedIn(true)} />;

  const overallMishit =
    scoped.length ? scoped.filter((s) => s.quality === 'mishit').length / scoped.length : null;
  const filtered = selectedClubs.size < availableClubs.length;

  return (
    <div className="app">
      <header>
        <h1>untrackman</h1>
        <div className="actions">
          <label className="toggle">
            <input
              type="checkbox"
              checked={goodOnly}
              onChange={(e) => setGoodOnly(e.target.checked)}
            />
            Clean strikes only
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={bayCorrect}
              onChange={(e) => setBayCorrect(e.target.checked)}
            />
            Bay-corrected
          </label>
          {hiddenShotCount > 0 && (
            <label className="toggle" title="Sessions you hid in the TrackMan app">
              <input
                type="checkbox"
                checked={showHidden}
                onChange={(e) => setShowHidden(e.target.checked)}
              />
              Hidden sessions
            </label>
          )}
          <button onClick={() => runSync(false)} disabled={!!progress}>
            {progress ? 'Syncing…' : 'Sync'}
          </button>
          <button
            className="ghost"
            onClick={() => {
              const blob = new Blob([toCsv(shots)], { type: 'text/csv' });
              const a = document.createElement('a');
              a.href = URL.createObjectURL(blob);
              a.download = `untrackman-${new Date().toISOString().slice(0, 10)}.csv`;
              a.click();
              URL.revokeObjectURL(a.href);
            }}
            disabled={!shots.length}
          >
            CSV
          </button>
          <button
            className="ghost"
            onClick={() => {
              clearTokens();
              setSignedIn(false);
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      {progress && (
        <div className="progress">
          {progress.phase === 'activities'
            ? `Finding sessions… ${progress.sessionsSeen}/${progress.sessionsTotal}`
            : `Session ${progress.sessionsFetched}/${progress.sessionsTotal}` +
              (progress.currentLabel ? ` — ${progress.currentLabel}` : '') +
              ` · ${progress.strokesStored} shots`}
        </div>
      )}
      {error && <div className="error banner">{error}</div>}

      {!shots.length && !progress && (
        <div className="empty">
          <p>No shots stored yet.</p>
          <button className="primary" onClick={() => runSync(true)}>
            Pull my range sessions
          </button>
        </div>
      )}

      {!!shots.length && (
        <>
          <nav className="tabs">
            {(['overview', 'clubs', 'gapping', 'dispersion', 'curve', 'fatigue', 'shots', 'bag'] as Tab[]).map(
              (t) => (
                <button
                  key={t}
                  className={tab === t ? 'active' : ''}
                  onClick={() => setTab(t)}
                >
                  {t}
                </button>
              ),
            )}
          </nav>

          {hiddenShotCount > 0 && !showHidden && (
            <p className="note">
              {hiddenShotCount} shots from {hiddenIds.size} hidden session
              {hiddenIds.size === 1 ? '' : 's'} are excluded. Sessions hidden in the
              TrackMan app usually have something wrong with them — mislabelled clubs
              being the common one — so they are left out unless you ask for them.
            </p>
          )}

          <ClubFilter
            available={availableClubs}
            selected={selectedClubs}
            onChange={setClubs}
            counts={shotCounts}
          />

          {selectedClubs.size === 0 && (
            <div className="empty">
              <p>No clubs selected.</p>
              <button className="primary" onClick={() => setClubs(new Set(availableClubs))}>
                Show all clubs
              </button>
            </div>
          )}

          {selectedClubs.size > 0 && tab === 'overview' && (
            <section>
              <div className="cards">
                <Card label="Sessions" value={String(trends.length)} />
                <Card
                  label="Shots"
                  value={String(scoped.length)}
                  hint={filtered ? `of ${shots.length} total` : undefined}
                />
                <Card label="Mishit rate" value={pct(overallMishit)} />
                <Card
                  label="Clean strikes"
                  value={String(scoped.filter((s) => s.quality === 'good').length)}
                />
              </div>

              <h2>{metric.label} over time</h2>
              <div className="metric-switch">
                {TREND_METRICS.map((m) => (
                  <button
                    key={m.key}
                    className={`chip ${m.key === metricKey ? 'active' : ''}`}
                    onClick={() => setMetricKey(m.key)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>

              <Chart
                deps={[trends, metric, selectedClubs]}
                options={{
                  height: 340,
                  marginLeft: 55,
                  x: { type: 'utc', label: 'Session' },
                  y: {
                    label: metric.axisLabel,
                    grid: true,
                    ...(metric.percent ? { percent: true, domain: [0, 100] } : {}),
                  },
                  color: { legend: true, type: 'categorical' },
                  marks: [
                    metric.zeroLine ? Plot.ruleY([0], { stroke: '#666' }) : Plot.ruleY([]),
                    // One dotted rule per session, so gaps in practice are visible
                    // rather than implied by uneven point spacing.
                    Plot.ruleX(
                      trends.map((t) => new Date(t.date)),
                      { stroke: '#39414f', strokeDasharray: '2 4' },
                    ),
                    // One series per selected club. Points with too few shots
                    // that session are dropped rather than drawn as noise.
                    ...[...selectedClubs]
                      .sort((a, b) => clubOrder(a) - clubOrder(b))
                      .flatMap((club) => {
                        const pts = trends
                          .map((t) => ({ t, c: t.byClub[club] }))
                          .filter(
                            (r) => r.c && r.c.shots >= MIN_SHOTS_FOR_TREND &&
                              metric.get(r.c) != null,
                          )
                          .map((r) => ({
                            date: new Date(r.t.date),
                            value: metric.get(r.c!)!,
                            club: clubLabel(club),
                            shots: r.c!.shots,
                          }));
                        if (pts.length < 2) return [];
                        return [
                          Plot.line(pts, {
                            x: 'date', y: 'value', stroke: 'club', strokeWidth: 2,
                          }),
                          Plot.dot(pts, {
                            x: 'date', y: 'value', fill: 'club', r: 4,
                            title: (d: any) =>
                              `${d.club}\n${metric.label}: ${
                                metric.percent ? pct(d.value) : fmt(d.value)
                              }\n${d.shots} shots`,
                          }),
                        ];
                      }),
                    // Fitted trendlines, only when few enough clubs are shown
                    // that six overlapping dashed lines would not be soup.
                    ...(selectedClubs.size <= 3
                      ? [...selectedClubs].flatMap((club) => {
                          const f = trendFit(trends, club, metric);
                          if (!f || f.r2 < 0.3) return [];
                          return [
                            Plot.line(
                              [
                                { d: new Date(f.from.date), v: f.from.value },
                                { d: new Date(f.to.date), v: f.to.value },
                              ],
                              {
                                x: 'd', y: 'v',
                                stroke: () => clubLabel(club),
                                strokeWidth: 1.5,
                                strokeDasharray: '5 4',
                                strokeOpacity: 0.7,
                              },
                            ),
                          ];
                        })
                      : []),
                  ],
                }}
              />
              <p className="note">
                Sessions where a club saw fewer than {MIN_SHOTS_FOR_TREND} shots are
                omitted — at that sample size the number moves in big steps for
                reasons that have nothing to do with your swing.
                {metric.key === 'mishitRate'
                  ? ' Mishit rate is over all shots; every other metric uses clean strikes only.'
                  : ''}
              </p>

              <h2>Trend</h2>
              <p className="note">
                Least-squares slope against actual dates, so uneven gaps between
                sessions are handled properly. R² says how much of the movement the
                line actually explains — below 0.30 the slope is not distinguishable
                from noise, however steep it looks.
              </p>
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Club</th><th>Sessions</th><th>Per week</th><th>R²</th><th>Read</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...selectedClubs]
                      .sort((a, b) => clubOrder(a) - clubOrder(b))
                      .map((club) => {
                        const f = trendFit(trends, club, metric);
                        if (!f) {
                          return (
                            <tr key={club}>
                              <td>{clubLabel(club)}</td>
                              <td className="num">—</td>
                              <td colSpan={3} className="muted-cell">
                                needs 3+ sessions with {MIN_SHOTS_FOR_TREND}+ shots
                              </td>
                            </tr>
                          );
                        }
                        const solid = f.r2 >= 0.3;
                        const better = metric.lowerIsBetter
                          ? f.slopePerWeek < 0
                          : f.slopePerWeek > 0;
                        const neutral = !metric.lowerIsBetter && !metric.percent &&
                          (metric.key === 'curveMean' || metric.key === 'launchMean');
                        const cls = !solid || neutral ? '' : better ? 'better' : 'worse';
                        const slope = metric.percent
                          ? `${f.slopePerWeek > 0 ? '+' : ''}${(f.slopePerWeek * 100).toFixed(1)} pts`
                          : `${f.slopePerWeek > 0 ? '+' : ''}${fmt(f.slopePerWeek)}`;
                        return (
                          <tr key={club}>
                            <td>{clubLabel(club)}</td>
                            <td className="num">{f.n}</td>
                            <td className={`num ${cls}`}>{slope}</td>
                            <td className="num">{f.r2.toFixed(2)}</td>
                            <td className="muted-cell">
                              {!solid
                                ? 'too noisy to call'
                                : neutral
                                  ? 'no better direction'
                                  : better
                                    ? 'improving'
                                    : 'getting worse'}
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {selectedClubs.size > 0 && tab === 'clubs' && (
            <section>
              <h2>Per-club</h2>
              <p className="note">
                Distances computed over {goodOnly ? 'clean strikes only' : 'all shots'}.
                Club speed is <strong>estimated</strong> from ball speed and an assumed
                smash factor — the range unit measures neither.
              </p>
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Club</th><th>Loft</th><th>n</th><th>Mishit</th>
                      <th>Carry med</th><th>σ</th><th>P25–P75</th><th>Max</th>
                      <th>Ball</th><th>Club*</th><th>Launch</th><th>vs loft*</th><th>Spin</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.map((s) => (
                      <tr key={s.club}>
                        <td>{s.label}</td>
                        <td>{s.loft == null ? '—' : `${s.loft}°`}</td>
                        <td>{s.nGood}/{s.n}</td>
                        <td>{pct(s.mishitRate)}</td>
                        <td className="num">{fmt(s.carryMedian)}</td>
                        <td className="num">{fmt(s.carryStdev)}</td>
                        <td className="num">{fmt(s.carryP25, 0)}–{fmt(s.carryP75, 0)}</td>
                        <td className="num">{fmt(s.carryMax)}</td>
                        <td className="num">{fmt(s.ballMphMean)}</td>
                        <td className="num est">{fmt(s.estClubMphMean)}</td>
                        <td className="num">{fmt(s.launchMean)}°</td>
                        <td className="num">{s.loftDeltaMean == null ? '—' : `${s.loftDeltaMean > 0 ? '+' : ''}${fmt(s.loftDeltaMean)}°`}</td>
                        <td className="num">{fmt(s.spinMean, 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {modelInfo && (
                <p className="note">
                  Expected-carry model fitted on {modelInfo.n} well-struck shots,
                  R² {modelInfo.r2.toFixed(2)}. It powers the strike-quality metric and
                  the third mishit rule.
                </p>
              )}
              <p className="note">
                * Club speed is estimated, not measured. “vs loft” is launch angle minus
                static loft and is <strong>always strongly negative for irons</strong> —
                launch tracks dynamic loft, not the number on the sole. It does not on its
                own mean you are removing loft. The per-shot <code>loftDeltaVsOwn</code>
                column in the CSV compares each shot to your own median for that club,
                which is the version that carries information.
              </p>

              <h2>Launch angle vs static loft</h2>
              <Chart
                deps={[stats]}
                options={{
                  height: 260,
                  marginLeft: 60,
                  x: { label: 'Static loft (°)' },
                  y: { label: 'Mean launch angle (°)', grid: true },
                  marks: [
                    Plot.line(
                      [
                        { l: 20, v: 20 },
                        { l: 45, v: 45 },
                      ],
                      { x: 'l', y: 'v', stroke: '#555', strokeDasharray: '4 4' },
                    ),
                    Plot.dot(stats.filter((s) => s.loft != null && s.launchMean != null), {
                      x: 'loft',
                      y: 'launchMean',
                      r: 6,
                      fill: '#4c9be8',
                      title: (d) => `${d.label}\nloft ${d.loft}°\nlaunch ${fmt(d.launchMean)}°`,
                    }),
                    Plot.text(stats.filter((s) => s.loft != null && s.launchMean != null), {
                      x: 'loft',
                      y: 'launchMean',
                      text: 'label',
                      dy: -12,
                      fill: '#aaa',
                    }),
                  ],
                }}
              />
              <p className="note">
                Dashed line is launch = static loft. Points above it mean you are
                delivering more loft than the club has at address.
              </p>
            </section>
          )}

          {selectedClubs.size > 0 && tab === 'gapping' && (
            <section>
              <h2>Gapping</h2>
              <div className="scroll">
                <table>
                  <thead>
                    <tr><th>Pair</th><th>Carry gap</th><th>Loft gap</th><th>Status</th></tr>
                  </thead>
                  <tbody>
                    {gaps.map((g) => (
                      <tr key={`${g.from}-${g.to}`} className={`gap-${g.status}`}>
                        <td>{g.fromLabel} → {g.toLabel}</td>
                        <td className="num">{fmt(g.gapYd)} yd</td>
                        <td className="num">{g.loftGap == null ? '—' : `${fmt(g.loftGap, 0)}°`}</td>
                        <td>{g.status}{g.note ? ` — ${g.note}` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {MISSING_SLOTS.map((m) => (
                <p key={m.label} className="callout">
                  <strong>{m.label}:</strong> {m.reason}
                </p>
              ))}

              <h2>Carry range by club</h2>
              <Chart
                deps={[stats]}
                options={{
                  height: 300,
                  marginLeft: 90,
                  x: { label: 'Carry (yd)', grid: true },
                  y: { label: null, domain: stats.map((s) => s.label) },
                  marks: [
                    Plot.ruleY(stats, {
                      y: 'label',
                      x1: 'carryP25',
                      x2: 'carryP75',
                      stroke: '#4c9be8',
                      strokeWidth: 10,
                      strokeLinecap: 'round',
                    }),
                    Plot.dot(stats, { y: 'label', x: 'carryMedian', fill: '#fff', r: 4 }),
                    Plot.dot(stats, { y: 'label', x: 'carryMax', fill: '#f0803c', r: 3 }),
                  ],
                }}
              />
              <p className="note">
                Bar is P25–P75, white dot is median, orange dot is best.
              </p>
            </section>
          )}

          {selectedClubs.size > 0 && tab === 'dispersion' && (
            <section>
              <h2>Dispersion</h2>
              <p className="note">
                {bayCorrect
                  ? 'Lateral position is bay-corrected — each bay\u2019s own aim offset removed.'
                  : 'Raw lateral position — includes up to 19° of bay aim error.'}{' '}
                Ellipses are 1σ covariance (about 39% of shots) and 2σ (about 86%).
              </p>
              <Chart
                deps={[visible, bayCorrect]}
                options={{
                  height: 480,
                  marginLeft: 60,
                  x: { label: 'Left ← carry side (yd) → Right', grid: true },
                  y: { label: 'Carry (yd)', grid: true },
                  color: { legend: true, type: 'categorical' },
                  marks: [
                    Plot.ruleX([0], { stroke: '#555' }),
                    // 2σ then 1σ so the tighter ring draws on top.
                    ...ellipseMarks(visible, sideOf, 2, 0.25),
                    ...ellipseMarks(visible, sideOf, 1, 0.6),
                    Plot.dot(
                      visible.filter((s) => sideOf(s) != null && s.carryYd != null),
                      {
                        x: (d) => sideOf(d)! / 3,
                        y: 'carryYd',
                        stroke: (d) => clubLabel(d.club),
                        r: 2.5,
                        opacity: 0.55,
                        title: (d) =>
                          `${clubLabel(d.club)}\n${fmt(d.carryYd)} yd\n${fmt(sideOf(d))} ft side\n${d.bayName ?? ''}`,
                      },
                    ),
                    ...ellipseCentreMarks(visible, sideOf),
                  ],
                }}
              />
              <div className="scroll">
                <table>
                  <thead>
                    <tr><th>Club</th><th>n</th><th>Centre</th><th>Side σ</th><th>Carry σ</th><th>Mean offline</th><th>Dir (adj)</th></tr>
                  </thead>
                  <tbody>
                    {stats.map((s) => {
                      const e = dispersionEllipse(
                        visible.filter((v) => v.club === s.club),
                      );
                      return (
                        <tr key={s.club}>
                          <td>{s.label}</td>
                          <td className="num">{e?.n ?? 0}</td>
                          <td className="num">
                            {e ? `${fmt(e.cx)} yd ${e.cx >= 0 ? 'R' : 'L'}` : '—'}
                          </td>
                          <td className="num">{fmt(s.sideStdev == null ? null : s.sideStdev / 3)}</td>
                          <td className="num">{fmt(s.carryStdev)}</td>
                          <td className="num">{fmt(s.offlineMean)} ft</td>
                          <td className="num">{fmt(s.launchDirAdjMean)}°</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <h2>Bay alignment</h2>
              <p className="note">
                Launch direction is reported against the bay→target line, so aiming
                anywhere else adds a constant offset. Keyed on bay <em>and</em> target —
                one bay can host several. “Geometric” is the offset predicted from the
                bay and target coordinates if you hit dead straight out of the bay; it
                tracks the measured value at r = 0.99, which is what confirms this is
                geometry rather than a swing pattern.
              </p>
              <div className="scroll">
                <table>
                  <thead>
                    <tr><th>Bay</th><th>Target</th><th>Shots</th><th>Aim offset</th><th>Geometric</th><th>IQR</th></tr>
                  </thead>
                  <tbody>
                    {bays.map((b) => (
                      <tr key={`${b.bay}-${b.targetId}`}>
                        <td>{b.bay}</td>
                        <td className="flags">{b.targetId?.slice(0, 8) ?? '—'}</td>
                        <td className="num">{b.n}</td>
                        <td className="num">{b.offsetDeg > 0 ? '+' : ''}{fmt(b.offsetDeg)}°</td>
                        <td className="num">{b.geometricDeg == null ? '—' : `${(-b.geometricDeg) > 0 ? '+' : ''}${fmt(-b.geometricDeg)}°`}</td>
                        <td className="num">{fmt(b.spreadDeg)}°</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {selectedClubs.size > 0 && tab === 'curve' && (
            <section>
              <h2>Curvature</h2>
              <p className="note">
                Measured off the <strong>launch line</strong>, so it is independent of how
                the bay is aimed. Positive = curved right, negative = curved left.
              </p>
              <Chart
                deps={[visible]}
                options={{
                  height: 320,
                  marginLeft: 90,
                  x: { label: 'Curve (ft) — left ← 0 → right', grid: true },
                  y: { label: null },
                  marks: [
                    Plot.ruleX([0], { stroke: '#888' }),
                    Plot.boxX(
                      visible.filter((s) => s.curveFt != null && s.club),
                      { x: 'curveFt', y: (d) => clubLabel(d.club), fill: '#2a3140', stroke: '#4c9be8' },
                    ),
                  ],
                }}
              />
              <div className="scroll">
                <table>
                  <thead>
                    <tr><th>Club</th><th>Mean</th><th>Median</th><th>σ</th><th>Right %</th><th>Shape</th></tr>
                  </thead>
                  <tbody>
                    {stats.map((s) => (
                      <tr key={s.club}>
                        <td>{s.label}</td>
                        <td className="num">{fmt(s.curveMean)} ft</td>
                        <td className="num">{fmt(s.curveMedian)} ft</td>
                        <td className="num">{fmt(s.curveStdev)}</td>
                        <td className="num">{pct(s.fadeShare)}</td>
                        <td>
                          {s.fadeShare == null
                            ? '—'
                            : s.fadeShare > 0.75
                              ? 'one-way — fade'
                              : s.fadeShare < 0.25
                                ? 'one-way — draw'
                                : 'two-way miss'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {selectedClubs.size > 0 && tab === 'shots' && (
            <section>
              <h2>Shots ({visible.length})</h2>
              <div className="scroll">
                <table className="dense">
                  <thead>
                    <tr>
                      <th>Date</th><th>Bay</th><th>Club</th><th>Carry</th><th>Side</th><th>Ball</th>
                      <th>Launch</th><th>Dir</th><th>Land</th><th>Peak</th><th>Curve</th><th>Spin</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...visible]
                      .sort((a, b) => (b.carryYd ?? 0) - (a.carryYd ?? 0))
                      .slice(0, 300)
                      .map((s) => (
                        <tr key={s.id} className={s.quality === 'mishit' ? 'mishit' : ''}>
                          <td>{new Date(s.time).toLocaleDateString()}</td>
                          <td>{s.bayName ?? '—'}</td>
                          <td>{clubLabel(s.club)}</td>
                          <td className="num">{fmt(s.carryYd)}</td>
                          <td className="num">{fmt(sideOf(s))}</td>
                          <td className="num">{fmt(s.ballMph)}</td>
                          <td className="num">{fmt(s.launchAngle)}</td>
                          <td className="num">{fmt(dirOf(s))}</td>
                          <td className="num">{fmt(s.landingAngle)}</td>
                          <td className="num">{fmt(s.peakFt)}</td>
                          <td className="num">{fmt(s.curveFt)}</td>
                          <td className="num">{fmt(s.spinRpm, 0)}</td>
                          <td className="flags">
                            {s.isRawBall ? 'raw-ball ' : ''}
                            {s.accuracyFlags.includes('PotentialGhost') ? 'ghost' : ''}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}

          {selectedClubs.size > 0 && tab === 'fatigue' && (
            <section>
              <h2>Session fatigue</h2>
              <p className="note">
                Shot quality against position within the session, pooled across all
                sessions. Answers a question none of the other views do: how long is a
                session actually productive? Binned by shots hit rather than minutes,
                because balls are what tire you.
              </p>
              <Chart
                deps={[fatigue]}
                options={{
                  height: 300,
                  marginLeft: 55,
                  x: { label: 'Shot number within session', domain: fatigue.map((b) => b.label) },
                  y: { label: 'Mishit rate', percent: true, domain: [0, 100], grid: true },
                  marks: [
                    Plot.ruleY([0]),
                    Plot.barY(fatigue, {
                      x: 'label',
                      y: 'mishitRate',
                      fill: '#f0803c',
                      fillOpacity: 0.75,
                      title: (d: any) => `${d.label}\n${d.shots} shots\n${pct(d.mishitRate)} mishit`,
                    }),
                  ],
                }}
              />
              <Chart
                deps={[fatigue]}
                options={{
                  height: 260,
                  marginLeft: 55,
                  x: { label: 'Shot number within session', domain: fatigue.map((b) => b.label) },
                  y: { label: 'Median ball speed, clean strikes (mph)', grid: true },
                  marks: [
                    Plot.line(fatigue.filter((b) => b.ballMphMedian != null), {
                      x: 'label', y: 'ballMphMedian', stroke: '#4c9be8', strokeWidth: 2,
                    }),
                    Plot.dot(fatigue.filter((b) => b.ballMphMedian != null), {
                      x: 'label', y: 'ballMphMedian', fill: '#4c9be8', r: 4,
                      title: (d: any) => `${d.label}\n${fmt(d.ballMphMedian)} mph\n${d.shots} shots`,
                    }),
                  ],
                }}
              />
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Shots</th><th>n</th><th>Mishit</th><th>Ball speed</th><th>Strike quality</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fatigue.map((b) => (
                      <tr key={b.label}>
                        <td>{b.label}</td>
                        <td className="num">{b.shots}</td>
                        <td className="num">{pct(b.mishitRate)}</td>
                        <td className="num">{fmt(b.ballMphMedian)}</td>
                        <td className="num">{pct(b.carryEfficiencyMedian)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="note">
                Strike quality is median carry as a fraction of what the launch
                conditions should have produced. Later bins pool fewer sessions —
                not every session runs to 60 shots — so read the tail with the n
                column in view.
              </p>
            </section>
          )}

          {tab === 'bag' && (
            <BagEditor
              bag={bag}
              onChange={applyBag}
              onReset={() => { const d = resetBag(); saveBag(d); setBagState(d); }}
              seenClubIds={new Set(shots.map((s) => s.club).filter((c): c is string => !!c))}
            />
          )}

      <footer>
        <button
          className="ghost danger"
          onClick={async () => {
            if (confirm('Delete all locally stored shots? Re-syncing will pull them again.')) {
              await clearAll();
              await reload();
            }
          }}
        >
          Clear local data
        </button>
      </footer>
    </div>
  );
}

function Card({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card">
      <div className="card-value">{value}</div>
      <div className="card-label">{label}</div>
      {hint && <div className="card-hint">{hint}</div>}
    </div>
  );
}

/**
 * Covariance ellipses as parametric polylines.
 *
 * Observable Plot has no ellipse mark, so each ring is sampled as a closed
 * line. Drawn from the covariance of (side, carry), which is why they tilt:
 * a club whose long misses also go right produces a diagonal ellipse, and that
 * correlation is exactly the thing a plain σ pair hides.
 */
function ellipseMarks(
  shots: Shot[],
  sideOf: (s: Shot) => number | null,
  sigma: number,
  opacity: number,
) {
  const byClub = new Map<string, Shot[]>();
  for (const s of shots) {
    if (!s.club || sideOf(s) == null || s.carryYd == null) continue;
    if (!byClub.has(s.club)) byClub.set(s.club, []);
    byClub.get(s.club)!.push(s);
  }

  const marks: ReturnType<typeof Plot.line>[] = [];
  for (const [club, group] of byClub) {
    const e = dispersionEllipse(
      group.map((s) => ({ ...s, carrySideAdjFt: sideOf(s) })),
    );
    if (!e) continue;
    const theta = (e.angleDeg * Math.PI) / 180;
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i <= 64; i++) {
      const t = (i / 64) * Math.PI * 2;
      const px = e.rx * sigma * Math.cos(t);
      const py = e.ry * sigma * Math.sin(t);
      pts.push({
        x: e.cx + px * Math.cos(theta) - py * Math.sin(theta),
        y: e.cy + px * Math.sin(theta) + py * Math.cos(theta),
      });
    }
    marks.push(
      Plot.line(pts, {
        x: 'x',
        y: 'y',
        stroke: () => clubLabel(club),
        strokeWidth: sigma === 1 ? 2 : 1.25,
        strokeOpacity: opacity,
        strokeDasharray: sigma === 1 ? undefined : '3 3',
      }),
    );
  }
  return marks;
}

/** Centre marker for each club's dispersion — the average miss. */
function ellipseCentreMarks(shots: Shot[], sideOf: (s: Shot) => number | null) {
  const byClub = new Map<string, Shot[]>();
  for (const s of shots) {
    if (!s.club || sideOf(s) == null || s.carryYd == null) continue;
    if (!byClub.has(s.club)) byClub.set(s.club, []);
    byClub.get(s.club)!.push(s);
  }
  const centres: { x: number; y: number; club: string }[] = [];
  for (const [club, group] of byClub) {
    const e = dispersionEllipse(
      group.map((s) => ({ ...s, carrySideAdjFt: sideOf(s) })),
    );
    if (e) centres.push({ x: e.cx, y: e.cy, club: clubLabel(club) });
  }
  return [
    Plot.dot(centres, {
      x: 'x',
      y: 'y',
      fill: 'club',
      r: 5,
      stroke: '#0f1115',
      strokeWidth: 1.5,
    }),
  ];
}
