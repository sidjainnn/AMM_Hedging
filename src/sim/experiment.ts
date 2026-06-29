// 5-market hedging experiment (controlled BTC stress).
//
// Human-like (behavioral) agents run FIVE full 5-minute markets on a real recent
// Binance window. To measure "does hedging remove the AMM's directional /
// liquidity-skew risk", we stress the SAME 5-market flow across a wide range of
// BTC outcomes (−3%…+3% terminal, real intraday wiggles preserved) and overlay
// four perp-hedge strategies, each sized to the full ~10k budget:
//   none · delta (neutralise skew) · sentiment · combined (delta + sentiment tilt)
//
// The directional risk = slope of final P&L vs the BTC move (β, $/%). A good
// skew hedge flattens it (|β| → 0).
//
//   npx esbuild src/sim/experiment.ts --bundle --platform=node --format=esm \
//     --outfile=/tmp/exp.mjs && node /tmp/exp.mjs

import { Simulation } from './sim';
import { defaultConfig } from './config';

const TICKS_PER_MARKET = 300;
const MARKETS = 5;
const N = TICKS_PER_MARKET * MARKETS;
const BUDGET_USDT = 10000;
const FEE_BPS = defaultConfig.feeBps;
const SHOCKS = [-3, -2, -1, -0.5, 0, 0.5, 1, 2, 3]; // % terminal BTC move

type Strat = 'none' | 'delta' | 'sentiment' | 'combined';
const STRATS: Strat[] = ['none', 'delta', 'sentiment', 'combined'];

const clamp = (x: number, c: number) => Math.max(-c, Math.min(c, x));
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
function beta(x: number[], y: number[]): number {
  const mx = mean(x), my = mean(y); let n = 0, d = 0;
  for (let i = 0; i < x.length; i++) { n += (x[i] - mx) * (y[i] - my); d += (x[i] - mx) ** 2; }
  return d ? n / d : 0;
}

interface Book { pos: number; avg: number; realized: number; fees: number; }
function reconcile(b: Book, target: number, spot: number) {
  const trade = target - b.pos;
  if (Math.abs(trade) < 1e-7) return;
  b.fees += Math.abs(trade) * spot * (FEE_BPS / 1e4);
  if (b.pos !== 0 && Math.sign(trade) !== Math.sign(b.pos)) {
    const closed = Math.min(Math.abs(trade), Math.abs(b.pos));
    b.realized += Math.sign(b.pos) * closed * (spot - b.avg);
    const rem = b.pos + trade;
    if (Math.sign(rem) === Math.sign(trade) && rem !== 0) b.avg = spot;
    b.pos = rem;
  } else {
    const np = b.pos + trade;
    b.avg = np !== 0 ? (b.pos * b.avg + trade * spot) / np : 0;
    b.pos = np;
  }
}
const hpnl = (b: Book, spot: number) => b.realized + b.pos * (spot - b.avg) - b.fees;

// run the 5-market flow on a given price path; return final net P&L per strategy
function run(path: number[]): Record<Strat, number> {
  const sim = new Simulation({
    ...defaultConfig, externalPrice: true, btcStart: path[0], seed: 42,
    noiseIntensity: 1.5, directionalIntensity: 4.0, arbIntensity: 0.6,
  });
  const books = Object.fromEntries(STRATS.map((s) => [s, { pos: 0, avg: 0, realized: 0, fees: 0 }])) as Record<Strat, Book>;
  const net: Record<Strat, number> = { none: 0, delta: 0, sentiment: 0, combined: 0 };
  for (let i = 0; i < N; i++) {
    sim.feedPrice(path[i]);
    sim.step();
    const s = sim.getState();
    const spot = s.btc;
    const c = s.books.find((b) => b.id === 'C')!;
    const common = c.spreadCapture + c.inventoryPnl;
    const delta = s.aggregateDelta;
    const lean = s.sentiment?.lean ?? 0;
    const cap = BUDGET_USDT / spot;
    const targets: Record<Strat, number> = {
      none: 0, delta: clamp(delta, cap), sentiment: clamp(lean * cap, cap),
      combined: clamp(delta + 0.5 * cap * lean, cap),
    };
    for (const st of STRATS) { reconcile(books[st], targets[st], spot); net[st] = common + hpnl(books[st], spot); }
  }
  return net;
}

function basePath(closes: number[]): number[] {
  const b: number[] = [];
  for (let i = 0; i < closes.length - 1 && b.length < N; i++)
    for (let s = 0; s < 60 && b.length < N; s++) b.push(closes[i] + (closes[i + 1] - closes[i]) * (s / 60));
  while (b.length < N) b.push(closes[closes.length - 1]);
  return b;
}

// run the 9-shock sweep on one base window → β per strategy + the P&L table
function sweep(base: number[]) {
  const byStrat: Record<Strat, number[]> = { none: [], delta: [], sentiment: [], combined: [] };
  for (const sh of SHOCKS) {
    const path = base.map((p, i) => p * (1 + (sh / 100) * (i / (N - 1))));
    const net = run(path);
    for (const st of STRATS) byStrat[st].push(net[st]);
  }
  const b: Record<Strat, number> = {
    none: beta(SHOCKS, byStrat.none), delta: beta(SHOCKS, byStrat.delta),
    sentiment: beta(SHOCKS, byStrat.sentiment), combined: beta(SHOCKS, byStrat.combined),
  };
  return { byStrat, b };
}

async function main() {
  const raw = (await (await fetch(
    'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=300'
  )).json()) as string[][];
  const closes = raw.map((k) => parseFloat(k[4]));
  const WIN = Math.ceil(N / 60) + 1;
  // several non-overlapping real base windows → average the result
  const bases: number[][] = [];
  for (let i = 0; i + WIN < closes.length; i += WIN) bases.push(basePath(closes.slice(i, i + WIN + 1)));

  const std = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
  // per strategy, across windows: P&L dispersion over the BTC-outcome sweep, and worst-case
  const disp: Record<Strat, number[]> = { none: [], delta: [], sentiment: [], combined: [] };
  const worst: Record<Strat, number[]> = { none: [], delta: [], sentiment: [], combined: [] };
  let illustrative: ReturnType<typeof sweep> | null = null;
  for (const base of bases) {
    const r = sweep(base);
    for (const st of STRATS) { disp[st].push(std(r.byStrat[st])); worst[st].push(Math.min(...r.byStrat[st])); }
    if (!illustrative) illustrative = r;
  }

  console.log(`\n=== 5×5min hedging experiment · BTC-outcome stress · ${bases.length} real base windows · budget $${BUDGET_USDT} ===`);
  console.log('Human-like agents, same flow per window; terminal BTC move imposed (−3%…+3%, real wiggles kept).\n');

  console.log('Example sweep (one window) — final net P&L by BTC outcome (note the unhedged short-gamma hump):');
  console.log('BTC move   ' + STRATS.map((s) => s.padStart(10)).join(''));
  SHOCKS.forEach((sh, k) => {
    console.log(`${(sh > 0 ? '+' : '') + sh + '%'}`.padEnd(11) +
      STRATS.map((s) => ('$' + illustrative!.byStrat[s][k].toFixed(0)).padStart(10)).join(''));
  });

  console.log('\nLiquidity-skew risk across BTC outcomes (avg over windows):');
  console.log('strategy     P&L dispersion(σ)   worst-case$   dispersion removed');
  const dNone = mean(disp.none);
  for (const st of STRATS) {
    const md = mean(disp[st]);
    const mw = mean(worst[st]);
    const red = st === 'none' ? '—' : `${((1 - md / dNone) * 100).toFixed(0)}% lower`;
    console.log(`${st.padEnd(11)} ${('$' + md.toFixed(0)).padStart(14)}   ${('$' + mw.toFixed(0)).padStart(9)}   ${red}`);
  }
  return { disp, worst, dNone };
}

main();
