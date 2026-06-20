export const fmt = (x: number, d = 2): string =>
  x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

export const usd = (x: number): string =>
  (x < 0 ? '-$' : '$') + fmt(Math.abs(x), 0);

export const usd2 = (x: number): string =>
  (x < 0 ? '-$' : '$') + fmt(Math.abs(x), 2);

export const pct = (x: number, d = 1): string => fmt(x * 100, d) + '%';

export const cls = (x: number): string => (x >= 0 ? 'pos' : 'neg');

export const ticksToClock = (ticks: number): string => {
  const totalSec = Math.max(0, Math.round(ticks)); // 1 tick == 1 sim-second
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
};
