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

  // external (live-feed) mode: when true, step() consumes a fed real price
  // instead of generating a GBM walk. estSigma is then realised from the real
  // returns (still deployment-available).
  external = false;
  private pendingSpot: number | null = null;

  constructor(
    private rng: RNG,
    start: number,
    private volPerTick: number, // TRUE sigma (sim-ground-truth, GBM mode only)
    private driftPerTick: number,
    private jumpChance: number,
    private jumpSize: number
  ) {
    this.spot = start;
    this.estSigma = volPerTick; // seed estimate at true (warmup converges)
  }

  // push the latest live price; consumed on the next step() in external mode.
  feed(spot: number): void {
    if (spot > 0) this.pendingSpot = spot;
  }

  // advance one tick of GBM with optional jumps; update EWMA estimate.
  step(): void {
    if (this.external) {
      this.stepExternal();
      return;
    }
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

  // Live mode: adopt the fed price; realise est-vol from the real return.
  private stepExternal(): void {
    if (this.pendingSpot == null) {
      this.lastLogRet = 0;
      return; // no fresh price yet → hold
    }
    const logRet = Math.log(this.pendingSpot / this.spot);
    this.spot = this.pendingSpot;
    this.lastLogRet = logRet;
    const r2 = logRet * logRet;
    this.estSigma = Math.sqrt(this.lambda * this.estSigma ** 2 + (1 - this.lambda) * r2);
  }

  get lastReturn(): number {
    return this.lastLogRet;
  }
}
