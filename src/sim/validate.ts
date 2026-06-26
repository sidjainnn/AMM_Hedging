// Validation harness — answers two questions:
//   (a) FAITHFULNESS: does the sim obey its own golden rules / invariants?
//   (b) THESIS: does the strategy break even / profit, and does hedging help?
//
// Run headless:
//   npx esbuild src/sim/validate.ts --bundle --platform=node --format=esm \
//     --outfile=/tmp/validate.mjs && node /tmp/validate.mjs

import { Simulation } from './sim';
import { defaultConfig as _dc } from './config';
import { Market } from './market';
import type { SimConfig } from './types';

// validation runs headless — force synthetic price (no live feed available)
const defaultConfig = { ..._dc, externalPrice: false };

let failures = 0;
function check(name: string, pass: boolean, detail = '') {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!pass) failures++;
}
const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

// ----------------------------------------------------------------------------
console.log('\n=== (a) FAITHFULNESS / INVARIANTS ===');

// 1. Determinism: same seed -> identical outcome.
{
  const run = () => {
    const s = new Simulation({ ...defaultConfig, seed: 7 });
    for (let i = 0; i < 2000; i++) s.step();
    return s.getState().books.find((b) => b.id === 'A')!.netPnl;
  };
  const a = run();
  const b = run();
  check('determinism (seed 7, 2000 ticks)', a === b, `net=${a.toFixed(2)}`);
}

// 2. Prices always valid: pYes in (0,1), bid<=ask, all finite.
{
  const s = new Simulation({ ...defaultConfig, seed: 3 });
  let ok = true;
  for (let i = 0; i < 3000; i++) {
    s.step();
    for (const m of s.getState().markets) {
      if (!(m.pYes > 0 && m.pYes < 1) || m.bid > m.ask || !isFinite(m.pYes)) ok = false;
    }
  }
  check('prices valid: 0<P(YES)<1, bid<=ask, finite', ok);
}

// 3. Pair-mint is price-neutral (golden rule #3): opposing limits that mint a
//    $1 pair must NOT change engine q or price.
{
  const m = new Market('t', '5m', 68000, 0, 300, defaultConfig.engine);
  const p0 = m.engine.pYes();
  const q0 = `${m.engine.qY}/${m.engine.qN}`;
  m.postLimit({ side: 'YES', limitPrice: 0.6, shares: 10, actor: 'x' });
  m.postLimit({ side: 'NO', limitPrice: 0.6, shares: 10, actor: 'y' });
  m.matchPairs(1);
  const minted = m.lastTrades.some((t) => t.channel === 'pair-mint');
  check('pair-mint executed', minted);
  check('pair-mint price-neutral (q & P unchanged)',
    approx(m.engine.pYes(), p0) && `${m.engine.qY}/${m.engine.qN}` === q0);
}

// 4. Quoting overlay never mutates q (golden rule #5).
{
  const m = new Market('t', '5m', 68000, 0, 300, defaultConfig.engine);
  m.executeEngineBuy('YES', 50, 'x', 1); // create some inventory
  const q0 = `${m.engine.qY}/${m.engine.qN}`;
  for (const k of [10, 25, 60]) {
    m.refreshQuote(1, { ...defaultConfig.quote, k });
  }
  check('quoting does not mutate q', `${m.engine.qY}/${m.engine.qN}` === q0);
}

// 5. Only engine trades move price; engine buys DO move it.
{
  const m = new Market('t', '5m', 68000, 0, 300, defaultConfig.engine);
  const p0 = m.engine.pYes();
  m.executeEngineBuy('YES', 30, 'x', 1);
  check('engine trade moves price', m.engine.pYes() > p0,
    `${p0.toFixed(3)} -> ${m.engine.pYes().toFixed(3)}`);
}

// 6. LMSR bounded loss: a market driven hard one way then settled in the
//    money loses at most ~b·ln2 on the engine-curve (the liquidity subsidy).
{
  const b = defaultConfig.engine.b0;
  const m = new Market('t', '5m', 68000, 0, 300, { ...defaultConfig.engine, kind: 'LMSR' });
  let cash = 0;
  for (let i = 0; i < 40; i++) cash += m.engine.applyBuy('YES', 20); // hammer YES
  const payout = m.engine.settlementLiability(true); // YES wins
  const engineCurvePnl = cash - payout;
  check('LMSR engine-curve loss >= -b·ln2', engineCurvePnl >= -(b * Math.log(2)) - 1e-6,
    `pnl=${engineCurvePnl.toFixed(2)} bound=${(-b * Math.log(2)).toFixed(2)}`);
}

// 7. P&L decomposition reconciles: net == spread + inventory + hedge + funding - fees.
{
  const s = new Simulation({ ...defaultConfig, seed: 11 });
  for (let i = 0; i < 2500; i++) s.step();
  let ok = true;
  for (const bk of s.getState().books) {
    const recon = bk.spreadCapture + bk.inventoryPnl + bk.hedgePnl + bk.funding - bk.fees;
    if (!approx(recon, bk.netPnl, 1e-3)) ok = false;
  }
  check('P&L decomposition reconciles for A/B/C', ok);
}

// ----------------------------------------------------------------------------
console.log('\n=== (b) THESIS: break-even/profit + hedging value ===');

const seeds = [1, 7, 42, 99, 256, 777, 2024, 31337];
const N = 8000;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const std = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};
// std of tick-to-tick increments of a series = how bumpy the equity curve is.
const incStd = (xs: number[]) => {
  const d: number[] = [];
  for (let i = 1; i < xs.length; i++) d.push(xs[i] - xs[i - 1]);
  return std(d);
};

// Break-even profitability across seeds.
function breakEven(patch: Partial<SimConfig>) {
  const nets: number[] = [];
  for (const seed of seeds) {
    const s = new Simulation({ ...defaultConfig, ...patch, seed } as SimConfig);
    for (let i = 0; i < N; i++) s.step();
    nets.push(s.getState().books.find((b) => b.id === 'A')!.netPnl);
  }
  return { mean: mean(nets), profit: nets.filter((n) => n >= 0).length,
    worst: Math.min(...nets), best: Math.max(...nets) };
}

for (const model of ['behavioral', 'simple'] as const) {
  const r = breakEven({ agentModel: model });
  console.log(`\n  agentModel = ${model}`);
  console.log(`    mean net ${r.mean.toFixed(0)}  | profitable ${r.profit}/${seeds.length}  | range [${r.worst.toFixed(0)}, ${r.best.toFixed(0)}]`);
  check(`${model}: net break-even or profit (mean >= 0)`, r.mean >= 0);
}

// Hedging value — measured the way a delta hedge is actually meant to help:
//   (1) within-path equity-curve smoothing (lower bumpiness)
//   (2) DIRECTIONAL stress: in a strong trend the maker accrues one-sided
//       inventory and the hedge should cut the worst-case loss.
console.log('\n  --- hedging value (Book A vs unhedged = spread+inventory) ---');

// (1) intra-path smoothing on the default (balanced) regime
{
  let hedgedBump = 0, unhedgedBump = 0;
  for (const seed of seeds) {
    const s = new Simulation({ ...defaultConfig, seed });
    for (let i = 0; i < N; i++) s.step();
    const ser = s.getState().pnlSeries;
    hedgedBump += incStd(ser.map((p) => p.A));
    unhedgedBump += incStd(ser.map((p) => p.spreadCapture + p.inventoryPnl));
  }
  hedgedBump /= seeds.length; unhedgedBump /= seeds.length;
  console.log(`    balanced regime — equity-curve bumpiness: hedged ${hedgedBump.toFixed(2)} vs unhedged ${unhedgedBump.toFixed(2)}`);
}

// (2) directional stress: crank drift so a real trend builds.
{
  const trend = { btcDriftPerTick: 0.00004, jumpChance: 0.02 } as Partial<SimConfig>;
  const hedged: number[] = [], unhedged: number[] = [];
  for (const seed of seeds) {
    const s = new Simulation({ ...defaultConfig, ...trend, seed } as SimConfig);
    for (let i = 0; i < N; i++) s.step();
    const a = s.getState().books.find((b) => b.id === 'A')!;
    hedged.push(a.netPnl);
    unhedged.push(a.spreadCapture + a.inventoryPnl);
  }
  console.log(`    trending regime — worst-case net: hedged ${Math.min(...hedged).toFixed(0)} vs unhedged ${Math.min(...unhedged).toFixed(0)}`);
  console.log(`    trending regime — mean net:       hedged ${mean(hedged).toFixed(0)} vs unhedged ${mean(unhedged).toFixed(0)}`);
  check('hedging improves worst-case loss in a trend', Math.min(...hedged) > Math.min(...unhedged));
}

// ----------------------------------------------------------------------------
console.log(`\n=== ${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'} ===\n`);
