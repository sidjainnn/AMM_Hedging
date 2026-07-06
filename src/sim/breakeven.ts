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

// 1b) gamma-wall fix A/B: pin-risk spread widening + expiry reduce-only lockout
function evalFull(over: Partial<SimConfig>) {
  const all: { net: number }[] = [];
  for (const seed of SEEDS) all.push(...run({ ...defaultConfig, externalPrice: false, seed, ...over }));
  const nets = all.map((w) => w.net);
  return { meanNet: mean(nets), stdNet: std(nets), worst: Math.min(...nets), breakEvenRate: all.filter((w) => w.net >= 0).length / all.length };
}
console.log('Gamma-wall fix A/B (Stoikov k=12):');
const off = evalFull({ quote: { ...defaultConfig.quote, gammaWiden: 0 }, expiryLockoutTicks: 0 });
const wid = evalFull({ expiryLockoutTicks: 0 });
const lck = evalFull({ quote: { ...defaultConfig.quote, gammaWiden: 0 } });
const both = evalFull({});
const fmtRow = (name: string, r: ReturnType<typeof evalFull>) =>
  `  ${name.padEnd(26)} mean $${r.meanNet.toFixed(1).padStart(6)}  | rate ${(r.breakEvenRate * 100).toFixed(0).padStart(3)}%  | worst $${r.worst.toFixed(0).padStart(5)}  | std ${r.stdNet.toFixed(0)}`;
console.log(fmtRow('off (neither)', off));
console.log(fmtRow('spread widen only', wid));
console.log(fmtRow('lockout only', lck));
console.log(fmtRow('both (default)', both));
console.log('');

// 1c) 5m-optimization A/B: invWiden + risk-tier hedge + 5m 60s lockout.
// Baselines: invWiden off (quote.invWiden=0); risk-tier off ⇔ hedgeNotionalUsdt=0
// (riskTierH then returns 1.0 always = the old static h=1 full hedge); 5m lockout
// reverts to the 30s default. FULL = the current frozen default.
console.log('5m-optimization A/B (Stoikov k=12, hedge ON):');
const Q = defaultConfig.quote;
const base = evalFull({ quote: { ...Q, invWiden: 0 }, hedgeNotionalUsdt: 0, expiryLockoutTicks5m: 30 });
const aInv = evalFull({ hedgeNotionalUsdt: 0, expiryLockoutTicks5m: 30 });               // +invWiden
const aTier = evalFull({ quote: { ...Q, invWiden: 0 }, expiryLockoutTicks5m: 30 });      // +risk-tier
const aLck = evalFull({ quote: { ...Q, invWiden: 0 }, hedgeNotionalUsdt: 0 });           // +5m 60s lockout
const aFull = evalFull({});                                                              // all three (default)
console.log(fmtRow('baseline (pre-opt)', base));
console.log(fmtRow('+ invWiden', aInv));
console.log(fmtRow('+ risk-tier hedge', aTier));
console.log(fmtRow('+ 5m 60s lockout', aLck));
console.log(fmtRow('FULL optimization', aFull));

// acceptance bar (user: "Robust break-even"): mean≥$50, rate≥90%, worst≥−$80, std≤$80
const pass = aFull.meanNet >= 50 && aFull.breakEvenRate >= 0.9 && aFull.worst >= -80 && aFull.stdNet <= 80;
console.log(`  acceptance (mean≥50, rate≥90%, worst≥−80, std≤80): ${pass ? 'PASS ✅' : 'FAIL ❌'}\n`);

// 1d) regime split: same FULL config in calm vs storm (different true BTC vol).
console.log('Regime split (FULL config, calm vs storm):');
console.log(fmtRow('calm  (vol 0.0006)', evalFull({ btcVolPerTick: 0.0006 })));
console.log(fmtRow('storm (vol 0.0020)', evalFull({ btcVolPerTick: 0.0020 })));
console.log('');

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
