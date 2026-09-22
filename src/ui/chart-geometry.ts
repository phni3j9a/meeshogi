/** Map a touch in the plot to a real position, including both endpoints. */
export function chartIndexAtX(
  x: number,
  left: number,
  width: number,
  count: number,
): number | null {
  if (!Number.isFinite(x) || width <= 0 || count < 1) return null;
  return Math.max(0, Math.min(count - 1, Math.round(((x - left) / width) * (count - 1))));
}

/** Prefer human-readable move intervals, keeping the final move without a crowded penultimate label. */
export function chartPlyTicks(last: number, intervals = 4): number[] {
  if (last <= 0) return [0];
  const rough = Math.max(1, last / Math.max(1, intervals));
  const unit = 10 ** Math.floor(Math.log10(rough));
  const step = Math.max(1, Math.round(rough / unit) * unit);
  const ticks = [0];
  for (let tick = step; tick < last; tick += step) {
    if (last - tick >= step / 2) ticks.push(tick);
  }
  return [...ticks, last];
}
