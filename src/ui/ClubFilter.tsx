/**
 * Club selection chips. Scopes every view on the page, not just the charts —
 * the summary cards, tables and gapping all respect it.
 *
 * Selection persists, because "show me only the long irons" is a mode you stay
 * in across visits rather than something you re-pick each time.
 */

import { clubLabel } from '../metrics/clubs';

const STORAGE_KEY = 'untrackman.clubFilter';

export function loadClubFilter(): Set<string> | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr as string[]) : null;
  } catch {
    return null;
  }
}

export function saveClubFilter(clubs: Set<string>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...clubs]));
}

export function ClubFilter({
  available,
  selected,
  onChange,
  counts,
}: {
  /** Clubs present in the data, in bag order. */
  available: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  /** Shot count per club, shown on each chip. */
  counts: Map<string, number>;
}) {
  const toggle = (club: string) => {
    const next = new Set(selected);
    if (next.has(club)) next.delete(club);
    else next.add(club);
    onChange(next);
  };

  const allOn = available.every((c) => selected.has(c));

  return (
    <div className="club-filter">
      <button
        className={`chip ${allOn ? 'active' : ''}`}
        onClick={() => onChange(new Set(available))}
        title="Show every club"
      >
        All
      </button>
      {available.map((c) => (
        <button
          key={c}
          className={`chip ${selected.has(c) ? 'active' : ''}`}
          onClick={() => toggle(c)}
          title={
            selected.has(c) ? `Hide ${clubLabel(c)}` : `Show ${clubLabel(c)}`
          }
        >
          {clubLabel(c)}
          <span className="chip-count">{counts.get(c) ?? 0}</span>
        </button>
      ))}
      <button
        className={`chip ${selected.size === 0 ? 'active' : ''}`}
        onClick={() => onChange(new Set())}
        title="Deselect every club"
      >
        None
      </button>
    </div>
  );
}
