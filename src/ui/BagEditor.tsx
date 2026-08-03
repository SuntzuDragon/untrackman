/**
 * Bag editor.
 *
 * The bag drives loft-relative analysis and the estimated club speed, so it has
 * to be editable rather than hardcoded — the defaults are one person's clubs.
 *
 * `trackmanId` is the load-bearing field: it must match exactly what the API
 * reports in `RangeStroke.club`, or the entry is inert. Everything else is
 * presentation or analysis input.
 */

import { useState } from 'react';
import {
  DEFAULT_BAG,
  KNOWN_CLUB_IDS,
  type ClubConfig,
  type LoftConfidence,
} from '../metrics/clubs';

const CONFIDENCES: LoftConfidence[] = ['verified', 'assumed', 'adjustable'];

export function BagEditor({
  bag,
  onChange,
  onReset,
  seenClubIds,
}: {
  bag: ClubConfig[];
  onChange: (next: ClubConfig[]) => void;
  onReset: () => void;
  /** Club ids actually present in the synced data. */
  seenClubIds: Set<string>;
}) {
  const [adding, setAdding] = useState(false);

  const update = (i: number, patch: Partial<ClubConfig>) => {
    const next = bag.map((c, j) => (j === i ? { ...c, ...patch } : c));
    onChange(next);
  };

  const remove = (i: number) => onChange(bag.filter((_, j) => j !== i));

  const add = (trackmanId: string) => {
    if (bag.some((c) => c.trackmanId === trackmanId)) return;
    const order = Math.max(-1, ...bag.map((c) => c.order)) + 1;
    onChange([
      ...bag,
      {
        trackmanId,
        label: trackmanId.replace(/([a-z])([A-Z0-9])/g, '$1 $2'),
        model: '',
        loft: null,
        loftConfidence: 'assumed',
        order,
        assumedSmash: null,
      },
    ]);
    setAdding(false);
  };

  const unconfigured = [...seenClubIds].filter(
    (id) => !bag.some((c) => c.trackmanId === id),
  );

  const isDefault =
    bag.length === DEFAULT_BAG.length &&
    bag.every((c, i) => c.trackmanId === DEFAULT_BAG[i]?.trackmanId && c.loft === DEFAULT_BAG[i]?.loft);

  return (
    <section>
      <h2>Ian&rsquo;s Bag</h2>
      <p className="note">
        Lofts drive the launch-vs-loft view; smash factor drives the estimated club
        speed (which the range unit never measures). <strong>Club</strong> must match
        the identifier Trackman reports, or the row does nothing.
      </p>

      {unconfigured.length > 0 && (
        <p className="callout">
          Your data contains clubs not in this bag: <strong>{unconfigured.join(', ')}</strong>.
          They still appear in the analysis, but without a loft or smash factor.
        </p>
      )}

      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Club</th><th>Name</th><th>Model</th>
              <th>Loft</th><th>Confidence</th><th>Smash</th><th>Order</th><th></th>
            </tr>
          </thead>
          <tbody>
            {bag.map((c, i) => (
              <tr key={`${c.trackmanId}-${i}`} className={seenClubIds.has(c.trackmanId) ? '' : 'unused'}>
                <td>
                  <code>{c.trackmanId}</code>
                  {!seenClubIds.has(c.trackmanId) && <span className="tag">unused</span>}
                </td>
                <td>
                  <input
                    value={c.label}
                    onChange={(e) => update(i, { label: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    className="wide"
                    value={c.model}
                    placeholder="make / model"
                    onChange={(e) => update(i, { model: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    className="narrow"
                    type="number"
                    step="0.5"
                    value={c.loft ?? ''}
                    onChange={(e) =>
                      update(i, { loft: e.target.value === '' ? null : Number(e.target.value) })
                    }
                  />
                </td>
                <td>
                  <select
                    value={c.loftConfidence}
                    onChange={(e) =>
                      update(i, { loftConfidence: e.target.value as LoftConfidence })
                    }
                  >
                    {CONFIDENCES.map((v) => (
                      <option key={v} value={v}>{v}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    className="narrow"
                    type="number"
                    step="0.01"
                    value={c.assumedSmash ?? ''}
                    onChange={(e) =>
                      update(i, {
                        assumedSmash: e.target.value === '' ? null : Number(e.target.value),
                      })
                    }
                  />
                </td>
                <td>
                  <input
                    className="narrow"
                    type="number"
                    value={c.order}
                    onChange={(e) => update(i, { order: Number(e.target.value) })}
                  />
                </td>
                <td>
                  <button className="ghost danger" onClick={() => remove(i)}>remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="bag-actions">
        {adding ? (
          <select autoFocus defaultValue="" onChange={(e) => e.target.value && add(e.target.value)}>
            <option value="" disabled>pick a club…</option>
            {KNOWN_CLUB_IDS.filter((id) => !bag.some((c) => c.trackmanId === id)).map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
        ) : (
          <button onClick={() => setAdding(true)}>Add club</button>
        )}
        <button className="ghost" onClick={onReset} disabled={isDefault}>
          Reset to defaults
        </button>
      </div>

      <p className="note">
        Ordering runs longest to shortest and controls the gapping view. Rows marked
        <span className="tag">unused</span> are in the bag but absent from your synced
        shots — which is itself worth noticing.
      </p>
    </section>
  );
}
