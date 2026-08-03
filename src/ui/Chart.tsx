/**
 * Thin React wrapper around Observable Plot.
 *
 * Plot renders imperatively into a DOM node, so we re-render on spec change and
 * clean up the previous figure.
 */

import { useEffect, useRef } from 'react';
import * as Plot from '@observablehq/plot';

export function Chart({
  options,
  deps = [],
}: {
  options: Plot.PlotOptions;
  deps?: unknown[];
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const figure = Plot.plot(options);
    el.append(figure);
    return () => figure.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return <div className="chart" ref={ref} />;
}
