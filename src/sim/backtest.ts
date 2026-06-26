// Headless backtest: run each pricing engine across several seeds and collect
// the Book-A net-P&L equity curve (averaged over seeds) plus summary stats.
// Reused by the Backtest page; deterministic, pure.

import { Simulation } from './sim';
import { defaultConfig } from './config';
import type { EngineKind, QuotingMode, SimConfig } from './types';

const ENGINES: EngineKind[] = ['LMSR', 'CPMM', 'LS-LMSR'];

export interface EnginePoint {
  tick: number;
  LMSR: number;
  CPMM: number;
  'LS-LMSR': number;
}
export interface EngineSummary {
  engine: EngineKind;
  mean: number;
  worst: number;
  best: number;
  profit: number; // # seeds with net >= 0
  seeds: number;
}
export interface BacktestResult {
  curve: EnginePoint[];
  summary: EngineSummary[];
}

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

export function runBacktest(opts: {
  mode: QuotingMode;
  manualHalfSpread?: number; // equal (symmetric) spread when mode = 'manual'
  seeds: number[];
  ticks: number;
  samples?: number;
}): BacktestResult {
  const { mode, seeds, ticks } = opts;
  const samples = opts.samples ?? 120;
  const stepEvery = Math.max(1, Math.floor(ticks / samples));

  const avgCurves: Record<EngineKind, number[]> = { LMSR: [], CPMM: [], 'LS-LMSR': [] };
  const finals: Record<EngineKind, number[]> = { LMSR: [], CPMM: [], 'LS-LMSR': [] };

  for (const engine of ENGINES) {
    const seedCurves: number[][] = [];
    for (const seed of seeds) {
      const cfg: SimConfig = {
        ...defaultConfig,
        seed,
        engine: { ...defaultConfig.engine, kind: engine },
        quote:
          mode === 'manual'
            ? {
                ...defaultConfig.quote,
                mode: 'manual',
                manualHalfSpread: opts.manualHalfSpread ?? 0.04,
              }
            : { ...defaultConfig.quote, mode: 'stoikov' },
      };
      const sim = new Simulation(cfg);
      const curve: number[] = [];
      for (let i = 1; i <= ticks; i++) {
        sim.step();
        if (i % stepEvery === 0) {
          curve.push(sim.getState().books.find((b) => b.id === 'A')!.netPnl);
        }
      }
      seedCurves.push(curve);
      finals[engine].push(curve[curve.length - 1] ?? 0);
    }
    const len = Math.min(...seedCurves.map((c) => c.length));
    const a: number[] = [];
    for (let j = 0; j < len; j++) a.push(avg(seedCurves.map((c) => c[j])));
    avgCurves[engine] = a;
  }

  const len = Math.min(...ENGINES.map((e) => avgCurves[e].length));
  const curve: EnginePoint[] = [];
  for (let j = 0; j < len; j++) {
    curve.push({
      tick: (j + 1) * stepEvery,
      LMSR: avgCurves.LMSR[j],
      CPMM: avgCurves.CPMM[j],
      'LS-LMSR': avgCurves['LS-LMSR'][j],
    });
  }

  const summary: EngineSummary[] = ENGINES.map((engine) => {
    const arr = finals[engine];
    return {
      engine,
      mean: avg(arr),
      worst: Math.min(...arr),
      best: Math.max(...arr),
      profit: arr.filter((x) => x >= 0).length,
      seeds: seeds.length,
    };
  });

  return { curve, summary };
}
