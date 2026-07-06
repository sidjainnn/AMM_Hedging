// Hedging layer (docs/hedging.md). Computes aggregate settlement-value delta
// across all live tenors and runs THREE parallel books that share the same
// underlying market-making book but differ only in their hedge leg:
//   A  pure delta hedge, TRUE sigma            (ground-truth neutral)
//   B  ride-the-bias, TRUE sigma, dial h<1     (policy: carry crowd signal)
//   C  pure delta hedge, ESTIMATED sigma       (deployment-realistic)
// A vs B = policy comparison; A vs C = deployment-realism (vol mis-estimation).
//
// Delta: bump the expected settlement value of the house's net inventory.
// L(S) = Σ [qY·p + qN·(1−p)] ⇒ dL/dS = Σ (qY−qN)·dp/dS. Hedge long BTC by
// that amount to neutralise. Flatten (drop a market from the target) when
// σ√τ ≤ k_flat — rehedging near expiry is uneconomical.

import { digitalProb } from './events';
import type { Market } from './market';
import type {
  HedgeBookId,
  HedgeBookState,
  HedgeActivity,
} from './types';

interface Book {
  id: HedgeBookId;
  label: string;
  h: number; // user-set dial (Book B = ride-bias, Books A/C = ignored — risk tier overrides)
  sigmaSource: 'true' | 'est';
  positionUnits: number;
  avgEntry: number;
  realizedHedge: number;
  fees: number;
  funding: number;
  target: number;
}

// Risk-tier function: returns the effective hedge dial h for Books A/C given
// the current notional exposure (|aggregate δ| × spot, USDT). Below the
// notional gate → 0 (no hedge, no fee churn). In the mid-tier → tierLow. In
// the high-tier → tierHigh. Above the upper threshold → 1.0 (fully hedged).
// The thresholds are (1x, 4x) the gate by default — chosen so a 200 USDT gate
// produces a 0/0.3/0.7/1.0 staircase as notional rises through 0/200/800/∞.
function riskTierH(notionalUsdt: number, gate: number, low: number, high: number): number {
  if (notionalUsdt < gate) return 0;
  if (notionalUsdt < gate * 4) return low;
  if (notionalUsdt < gate * 16) return high;
  return 1.0;
}

export class HedgeEngine {
  private books: Book[];
  // common market-making P&L, shared by all books
  accRealizedInventory = 0; // settled markets' fair P&L
  accRealizedSpread = 0; // settled markets' captured spread
  log: HedgeActivity[] = [];
  tauStar = 0;
  // notional gate (USDT): below this, Books A/C are flat (h=0). Above it,
  // h scales with exposure through the tier function.
  private hedgeNotionalUsdt: number;
  private riskTierLow: number;
  private riskTierHigh: number;

  constructor(
    hDialB: number,
    private kFlat: number,
    private feeBps: number,
    private fundingPerTick: number,
    hedgeNotionalUsdt: number = 200,
    riskTierLow: number = 0.3,
    riskTierHigh: number = 0.7
  ) {
    this.hedgeNotionalUsdt = hedgeNotionalUsdt;
    this.riskTierLow = riskTierLow;
    this.riskTierHigh = riskTierHigh;
    this.books = [
      this.mk('A', 'A · pure hedge (true δ)', 1, 'true'),
      this.mk('B', 'B · ride bias (true δ)', hDialB, 'true'),
      this.mk('C', 'C · pure hedge (approx δ)', 1, 'est'),
    ];
  }

  private mk(
    id: HedgeBookId,
    label: string,
    h: number,
    sigmaSource: 'true' | 'est'
  ): Book {
    return {
      id,
      label,
      h,
      sigmaSource,
      positionUnits: 0,
      avgEntry: 0,
      realizedHedge: 0,
      fees: 0,
      funding: 0,
      target: 0,
    };
  }

  setDialB(h: number): void {
    const b = this.books.find((x) => x.id === 'B');
    if (b) b.h = h;
  }
  setKFlat(k: number): void {
    this.kFlat = k;
  }
  setFeeBps(b: number): void {
    this.feeBps = b;
  }
  setFundingPerTick(f: number): void {
    this.fundingPerTick = f;
  }
  setHedgeNotionalUsdt(u: number): void {
    this.hedgeNotionalUsdt = u;
  }
  setRiskTier(low: number, high: number): void {
    this.riskTierLow = low;
    this.riskTierHigh = high;
  }

  // Aggregate delta (units of BTC) using a given sigma; flattens near-expiry.
  private aggregateDelta(
    markets: Market[],
    spot: number,
    sigma: number,
    tick: number
  ): number {
    let d = 0;
    for (const m of markets) {
      const tau = m.tau(tick);
      if (tau <= 0) continue;
      if (sigma * Math.sqrt(tau) <= this.kFlat) continue; // flattened
      const { dpdS } = digitalProb(spot, m.strike, sigma, tau);
      d += (m.engine.qY - m.engine.qN) * dpdS;
    }
    return d;
  }

  // True-sigma aggregate delta, for the headline "delta the hedge targets".
  trueAggregateDelta(
    markets: Market[],
    spot: number,
    trueSigma: number,
    tick: number
  ): number {
    return this.aggregateDelta(markets, spot, trueSigma, tick);
  }

  // accumulate realised P&L from markets that settled this tick.
  onSettled(settled: Market[]): void {
    for (const m of settled) {
      this.accRealizedSpread += m.spreadCapture;
      this.accRealizedInventory += m.cashCollected - m.spreadCapture;
    }
  }

  // common (book-independent) P&L: realised + live mark of the MM book.
  // Mark the open inventory at the ENGINE price (the actual transactable mid) —
  // the same price agents mark their positions at — so MM P&L and agent P&L
  // reconcile (one side's gain is the other's loss). Marking with a separate
  // model σ would double-count and make both sides look profitable.
  private commonPnl(markets: Market[]): { spread: number; inventory: number } {
    let liveSpread = 0;
    let liveInventory = 0;
    for (const m of markets) {
      liveSpread += m.spreadCapture;
      const p = m.engine.pYes(); // engine mid = mark-to-market price
      const markLiability = m.engine.qY * p + m.engine.qN * (1 - p);
      liveInventory += m.cashCollected - m.spreadCapture - markLiability;
    }
    return {
      spread: this.accRealizedSpread + liveSpread,
      inventory: this.accRealizedInventory + liveInventory,
    };
  }

  // one hedge tick: rebalance every book toward its target, accrue costs.
  // Returns aggregate state plus a per-book idleReason for the UI. Books A and
  // C use a risk-tier h (0 below the notional gate, then tierLow / tierHigh /
  // 1.0) so fee churn in flat regimes is zero. Book B keeps the user-set h.
  tick(
    markets: Market[],
    spot: number,
    trueSigma: number,
    estSigma: number,
    simTick: number
  ): {
    aggregateDelta: number;
    notionalUsdt: number;
    idleReason: import('./types').HedgeIdleReason;
    books: HedgeBookState[];
    tauStar: number;
  } {
    this.tauStar =
      estSigma > 0 ? (this.kFlat / estSigma) ** 2 : 0;
    const common = this.commonPnl(markets);

    // 1. compute the headline aggregate δ using true σ (the reference).
    const aggTrue = this.aggregateDelta(markets, spot, trueSigma, simTick);
    const notionalUsdt = Math.abs(aggTrue) * spot;
    const riskH = riskTierH(notionalUsdt, this.hedgeNotionalUsdt, this.riskTierLow, this.riskTierHigh);
    // idleReason describes why the *runner* is or isn't firing this tick. The
    // sim doesn't actually skip trades for the books (they still rebalance to
    // their target every tick), but the runner consumes `idleReason` to decide
    // whether to place a real order on Binance. 'untracked' only shows up
    // before the sim has ticked at least once.
    const idleReason: import('./types').HedgeIdleReason =
      riskH === 0 ? 'idle-inv' : 'armed';

    const states: HedgeBookState[] = [];
    for (const bk of this.books) {
      // Books A and C: risk-tier h (replaces the static h=1).
      // Book B: user-set dial (the ride-bias research knob).
      const effectiveH = bk.id === 'B' ? bk.h : riskH;
      const sigma = bk.sigmaSource === 'true' ? trueSigma : estSigma;
      const raw = this.aggregateDelta(markets, spot, sigma, simTick);
      bk.target = effectiveH * raw;

      const trade = bk.target - bk.positionUnits;
      if (Math.abs(trade) > 1e-6) {
        const fee = Math.abs(trade) * spot * (this.feeBps / 1e4);
        bk.fees += fee;
        // realise P&L when reducing or flipping the position
        const pos = bk.positionUnits;
        if (pos !== 0 && Math.sign(trade) !== Math.sign(pos)) {
          const closed = Math.min(Math.abs(trade), Math.abs(pos));
          bk.realizedHedge += Math.sign(pos) * closed * (spot - bk.avgEntry);
          const remaining = pos + trade;
          if (Math.sign(remaining) === Math.sign(trade) && remaining !== 0) {
            bk.avgEntry = spot; // flipped: new leg entered at spot
          }
          bk.positionUnits = remaining;
        } else {
          // adding to the position: weighted-average entry
          const newPos = pos + trade;
          bk.avgEntry =
            newPos !== 0 ? (pos * bk.avgEntry + trade * spot) / newPos : 0;
          bk.positionUnits = newPos;
        }
        this.log.unshift({
          tick: simTick,
          book: bk.id,
          deltaUnits: trade,
          markPrice: spot,
          fee,
        });
        if (this.log.length > 40) this.log.pop();
      }

      // funding accrues on the open notional (longs pay when rate>0)
      bk.funding += -bk.positionUnits * spot * this.fundingPerTick;

      const unrealized = bk.positionUnits * (spot - bk.avgEntry);
      const hedgePnl = bk.realizedHedge + unrealized;
      const netPnl =
        common.spread + common.inventory + hedgePnl + bk.funding - bk.fees;

      states.push({
        id: bk.id,
        label: bk.label,
        targetUnits: bk.target,
        positionUnits: bk.positionUnits,
        avgEntry: bk.avgEntry,
        realizedPnl: bk.realizedHedge,
        unrealizedPnl: unrealized,
        fees: bk.fees,
        funding: bk.funding,
        netPnl,
        spreadCapture: common.spread,
        inventoryPnl: common.inventory,
        hedgePnl,
        fundingAccrued: bk.funding,
        effectiveH,
      });
    }

    const aggDelta = this.aggregateDelta(markets, spot, trueSigma, simTick);
    return {
      aggregateDelta: aggDelta,
      notionalUsdt,
      idleReason,
      books: states,
      tauStar: this.tauStar,
    };
  }
}
