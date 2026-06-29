// Break-even QA harness for the 5-minute market.
//
// Question: does (spread + hedge) clear break-even per 5-minute window? The only
// revenue is the spread; costs are the LMSR subsidy + adverse selection + the
// hedge (fees/funding). We run many 5m windows with the delta hedge ON (Book C,
// the deployable book), measure net P&L per 5-minute window, and sweep the
// quoting spread to find the minimum that guarantees break-even.
//
//   npx esbuild src/sim/breakeven.ts --bundle --platform=node --format=esm \
//     --outfile=/tmp/be.mjs && node /tmp/be.mjs

import { Simulation } from './sim';
import { defaultConfig } from './config';
import type { SimConfig } from './types';

const TICKS_PER_MKT = 300; // 5 min
const MKTS = 8;            // 5m windows per run
const SEEDS = [1, 7, 42, 99, 256, 777, 2024, 31337];

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const std = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };

// run one config; return per-5m-window net + component deltas (Book C = spread+inv+hedge)
function run(cfg: SimConfig) {
  const sim = new Simulation(cfg);
  const wins: { net: number; spread: number; inv: number; hedge: number }[] = [];
  let last = { net: 0, spread: 0, inv: 0, hedge: 0 };
  for (let i = 1; i <= TICKS_PER_MKT * MKTS; i++) {
    sim.step();
    if (i % TICKS_PER_MKT === 0) {
      const c = sim.getState().books.find((b) => b.id === 'C')!;
      const cur = { net: c.netPnl, spread: c.spreadCapture, inv: c.inventoryPnl, hedge: c.hedgePnl - c.fees + c.fundingAccrued };
      wins.push({ net: cur.net - last.net, spread: cur.spread - last.spread, inv: cur.inv - last.inv, hedge: cur.hedge - last.hedge });
      last = cur;
    }
  }
  return wins;
}

// aggregate per-window stats over all seeds for a given quoting setup
function evaluate(quote: Partial<SimConfig['quote']>) {
  const all: { net: number; spread: number; inv: number; hedge: number }[] = [];
  for (const seed of SEEDS) {
    all.push(...run({ ...defaultConfig, externalPrice: false, seed, quote: { ...defaultConfig.quote, ...quote } }));
  }
  const nets = all.map((w) => w.net);
  return {
    n: all.length,
    meanNet: mean(nets),
    stdNet: std(nets),
    breakEvenRate: all.filter((w) => w.net >= 0).length / all.length,
    spread: mean(all.map((w) => w.spread)),
    inv: mean(all.map((w) => w.inv)),
    hedge: mean(all.map((w) => w.hedge)),
  };
}

console.log(`\n=== 5m break-even QA · ${SEEDS.length} seeds × ${MKTS} windows = ${SEEDS.length * MKTS} 5-minute windows · delta hedge ON ===`);
console.log('Per-5m-window means ($). Break-even ⇔ meanNet ≥ 0 and a high break-even rate.\n');

// 1) current default (Stoikov k=25)
const cur = evaluate({ mode: 'stoikov' });
console.log(`CURRENT default (Stoikov k=${defaultConfig.quote.k}):`);
console.log(`  mean net/window $${cur.meanNet.toFixed(1)}  | break-even rate ${(cur.breakEvenRate * 100).toFixed(0)}%  | spread +$${cur.spread.toFixed(1)}  inv $${cur.inv.toFixed(1)}  hedge $${cur.hedge.toFixed(1)}\n`);

// 2) sweep a fixed (manual) half-spread → the controllable break-even lever
console.log('Manual half-spread sweep (the guarantee knob):');
console.log('half-spread   mean net/window   break-even rate   spread / inv / hedge');
for (const hs of [0.01, 0.02, 0.03, 0.04, 0.05, 0.06]) {
  const r = evaluate({ mode: 'manual', manualHalfSpread: hs });
  console.log(
    `${(hs * 100).toFixed(0)}¢`.padEnd(13) +
    `${('$' + r.meanNet.toFixed(1)).padStart(13)}` +
    `${((r.breakEvenRate * 100).toFixed(0) + '%').padStart(17)}` +
    `      +$${r.spread.toFixed(0)} / $${r.inv.toFixed(0)} / $${r.hedge.toFixed(0)}`
  );
}

// 3) Stoikov k sweep (live product uses Stoikov; lower k = wider spread)
console.log('\nStoikov k sweep (lower k = wider spread; the live knob):');
console.log('k        mean net/window   break-even rate');
for (const k of [25, 20, 16, 12, 9, 6]) {
  const r = evaluate({ mode: 'stoikov', k });
  console.log(`${String(k).padEnd(8)}${('$' + r.meanNet.toFixed(1)).padStart(13)}${((r.breakEvenRate * 100).toFixed(0) + '%').padStart(17)}`);
}
