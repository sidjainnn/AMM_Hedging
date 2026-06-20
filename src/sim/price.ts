// Synthetic BTC price (docs/agents.md). Visible random walk, marked sim-only.
// Triple duty: (1) agents reference it, (2) hedge P&L marked against it,
// (3) ground truth for measuring crowd-bias signal.
//
// TRUE sigma is hidden ground truth (golden rule #6). Agents/Book C may only
// use estSigma — an EWMA of realised log-returns (deployment-available).

import { RNG } from './rng';

export class SyntheticPrice {
  spot: number;
  estSigma: number; // EWMA realised vol per tick (deployment-available)
  private lambda = 0.94; // EWMA decay
  private lastLogRet = 0;

  constructor(
    private rng: RNG,
    start: number,
    private volPerTick: number, // TRUE sigma (sim-ground-truth)
    private driftPerTick: number,
    private jumpChance: number,
    private jumpSize: number
  ) {
    this.spot = start;
    this.estSigma = volPerTick; // seed estimate at true (warmup converges)
  }

  // advance one tick of GBM with optional jumps; update EWMA estimate.
  step(): void {
    const z = this.rng.normal();
    let logRet = (this.driftPerTick - 0.5 * this.volPerTick ** 2) +
      this.volPerTick * z;
    if (this.rng.chance(this.jumpChance)) {
      logRet += this.rng.normal(0, this.jumpSize);
    }
    this.spot *= Math.exp(logRet);
    this.lastLogRet = logRet;
    // EWMA of squared returns -> estimated vol (RiskMetrics style)
    const r2 = logRet * logRet;
    const varEst =
      this.lambda * this.estSigma ** 2 + (1 - this.lambda) * r2;
    this.estSigma = Math.sqrt(varEst);
  }

  get lastReturn(): number {
    return this.lastLogRet;
  }
}
