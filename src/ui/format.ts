export const fmt = (x: number, d = 2): string =>
  x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

export const usd = (x: number): string =>
  (x < 0 ? '-$' : '$') + fmt(Math.abs(x), 0);

export const usd2 = (x: number): string =>
  (x < 0 ? '-$' : '$') + fmt(Math.abs(x), 2);

export const pct = (x: number, d = 1): string => fmt(x * 100, d) + '%';

export const cls = (x: number): string => (x >= 0 ? 'pos' : 'neg');

// Y-axis domain for a price series that is often nearly FLAT.
//
// Recharts' domain={['auto','auto']} fits the axis to the data range. When BTC
// only moves a few cents over the window (common on a 1-second tick), that range
// is ~$0 and sub-dollar jitter gets amplified to the full height of the chart —
// the line renders as a square wave and every tick label prints the same number.
// It looks broken, and it hides the fact that the price is simply calm.
//
// So: pad the fitted range, and never let the visible span fall below
// minSpanFrac of the price level (default 0.1% — enough that a genuinely flat
// series draws as a flat line near the middle of the axis).
export const priceDomain = (
  values: number[],
  minSpanFrac = 0.001,
  padFrac = 0.15,
): [number, number] => {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length === 0) return [0, 1];
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  const mid = (lo + hi) / 2;
  const span = Math.max(hi - lo, Math.abs(mid) * minSpanFrac, 1e-9);
  const half = (span / 2) * (1 + padFrac);
  return [mid - half, mid + half];
};

// Tick label for a price axis, with precision that adapts to how wide the axis
// actually is: a $2 span needs cents, a $20k span does not. Prevents an axis
// whose every label reads an identical rounded "63.1k".
export const priceTick =
  (span: number) =>
  (v: number): string => {
    if (span >= 5000) return (v / 1000).toFixed(1) + 'k';
    if (span >= 100) return '$' + fmt(v, 0);
    if (span >= 5) return '$' + fmt(v, 1);
    return '$' + fmt(v, 2);
  };

export const ticksToClock = (ticks: number): string => {
  const totalSec = Math.max(0, Math.round(ticks)); // 1 tick == 1 sim-second
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
};
