// Longevity + scenario stress harness. Does the frozen config hold up over
// TIME (hours of rolling markets, wallet-driven agent population evolving) and
// across REGIMES (calm/storm/jumps/trends/toxic flow) and ENGINES?
//
//   npx esbuild src/sim/stress.ts --bundle --platform=node --format=esm \
//     --outfile=/tmp/st.mjs && node /tmp/st.mjs

import { Simulation } from './sim';
import { defaultConfig } from './config';
import type { SimConfig } from './types';

const W = 300; // ticks per 5m window
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const std = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };

interface Win { net: number; spread: number; inv: number; hedge: number }

// run `windows` 5m windows; sample per-window Book-C components + agent stats
function run(cfg: SimConfig, windows: number) {
  const sim = new Simulation(cfg);
  const wins: Win[] = [];
  const agentTrack: { bankrupt: number; active: number }[] = [];
  let last = { net: 0, spread: 0, inv: 0, hedge: 0 };
  for (let i = 1; i <= W * windows; i++) {
    sim.step();
    if (i % W === 0) {
      const s = sim.getState();
      const c = s.books.find((b) => b.id === 'C')!;
      const cur = { net: c.netPnl, spread: c.spreadCapture, inv: c.inventoryPnl, hedge: c.hedgePnl - c.fees + c.fundingAccrued };
      wins.push({ net: cur.net - last.net, spread: cur.spread - last.spread, inv: cur.inv - last.inv, hedge: cur.hedge - last.hedge });
      last = cur;
      const a = s.agentStats;
      agentTrack.push({ bankrupt: a?.bankrupt ?? 0, active: a?.active ?? 0 });
    }
  }
  return { wins, agentTrack };
}

function agg(all: Win[]) {
  const nets = all.map((w) => w.net);
  return {
    mean: mean(nets), std: std(nets), worst: Math.min(...nets),
    rate: all.filter((w) => w.net >= 0).length / all.length,
    spread: mean(all.map((w) => w.spread)), inv: mean(all.map((w) => w.inv)), hedge: mean(all.map((w) => w.hedge)),
  };
}
const row = (name: string, a: ReturnType<typeof agg>) =>
  `  ${name.padEnd(24)} mean $${a.mean.toFixed(1).padStart(6)} | rate ${(a.rate * 100).toFixed(0).padStart(3)}% | worst $${a.worst.toFixed(0).padStart(5)} | std ${a.std.toFixed(0).padStart(3)} | spr $${a.spread.toFixed(0).padStart(4)} inv $${a.inv.toFixed(0).padStart(5)} hdg $${a.hedge.toFixed(1).padStart(6)}`;

const SEEDS = [7, 42, 777, 31337];
const base = (seed: number): SimConfig => ({ ...defaultConfig, externalPrice: false, seed });

// ---------- 1) LONGEVITY: 4 market-hours (48 windows) per seed ----------
console.log('\n=== 1) LONGEVITY · 48×5m windows (4h) × 4 seeds — degradation over time? ===');
{
  const HOURS = 4; const WINS = HOURS * 12;
  const byQuarter: Win[][] = [[], [], [], []];
  const bankruptAt: number[][] = [[], [], [], []]; // per quarter-end
  for (const seed of SEEDS) {
    const { wins, agentTrack } = run(base(seed), WINS);
    wins.forEach((w, i) => byQuarter[Math.floor(i / (WINS / 4))].push(w));
    for (let q = 0; q < 4; q++) bankruptAt[q].push(agentTrack[(q + 1) * (WINS / 4) - 1].bankrupt);
  }
  byQuarter.forEach((q, i) =>
    console.log(row(`hour ${i + 1}`, agg(q)) + ` | bankrupt ${mean(bankruptAt[i]).toFixed(1)}/95`));
}

// ---------- 2) SCENARIO MATRIX: 12 windows × 4 seeds each ----------
console.log('\n=== 2) SCENARIOS · 12×5m windows × 4 seeds each ===');
{
  const WINS = 12;
  const scenarios: [string, Partial<SimConfig>][] = [
    ['calm      (vol .0004)', { btcVolPerTick: 0.0004 }],
    ['normal    (vol .0011)', {}],
    ['storm     (vol .0025)', { btcVolPerTick: 0.0025 }],
    ['jumpy     (5% jumps)', { jumpChance: 0.05, jumpSize: 0.02 }],
    ['trend up  (+3.6%/h)', { btcDriftPerTick: 0.00001 }],
    ['trend dn  (−3.6%/h)', { btcDriftPerTick: -0.00001 }],
    ['one-sided (dir 2.0)', { directionalIntensity: 2.0, noiseIntensity: 0.8 }],
    ['toxic-only(noise .1)', { noiseIntensity: 0.1 }],
    ['high-arb  (arb 2.0)', { arbIntensity: 2.0 }],
    ['storm+one-sided', { btcVolPerTick: 0.0025, directionalIntensity: 2.0, noiseIntensity: 0.8 }],
  ];
  for (const [name, over] of scenarios) {
    const all: Win[] = [];
    for (const seed of SEEDS) all.push(...run({ ...base(seed), ...over }, WINS).wins);
    console.log(row(name, agg(all)));
  }
}

// ---------- 3) ENGINES under normal conditions ----------
console.log('\n=== 3) ENGINES · 12×5m windows × 4 seeds ===');
{
  const WINS = 12;
  for (const kind of ['LMSR', 'LS-LMSR', 'CPMM'] as const) {
    const all: Win[] = [];
    for (const seed of SEEDS) {
      const cfg = base(seed);
      all.push(...run({ ...cfg, engine: { ...cfg.engine, kind } }, WINS).wins);
    }
    console.log(row(kind, agg(all)));
  }
}
console.log('');
