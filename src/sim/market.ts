// A single binary market instance + the manager that rolls staggered tenors
// with a strike ladder (docs/markets.md). The order book is a ledger +
// execution layer, NOT a price-former (golden rule #2). Two channels:
//   - pair-mint (user<->user): opposing YES/NO orders mint $1 pairs,
//     price-neutral, no engine state change (golden rule #3).
//   - engine (user<->engine): marketable orders move q and therefore price.

import { makeEngine, type Engine } from './engines';
import { computeQuote, type Quote } from './quoting';
import type {
  EngineParams,
  QuoteParams,
  Side,
  TradePrint,
  RestingOrder,
  MarketSnapshot,
} from './types';

const MAX_PRINTS = 30;

export class Market {
  engine: Engine;
  restingBids: RestingOrder[] = [];
  lastTrades: TradePrint[] = [];
  cashCollected = 0; // premiums in, net of payouts
  spreadCapture = 0; // running half-spread captured
  quote: Quote;
  settled = false;
  // Per-market reduce-only lockout (set by MarketManager per tenor). When the
  // market is in the last `lockoutTicks` ticks of its life, executeEngineBuy
  // rejects trades that grow |netSkew|. 0 = off.
  lockoutTicks: number = 0;

  constructor(
    public id: string,
    public tenorLabel: string,
    public strike: number,
    public createdTick: number,
    public expiryTick: number,
    engineParams: EngineParams
  ) {
    this.engine = makeEngine(engineParams);
    this.quote = { bid: 0.49, ask: 0.51, reservation: 0.5 };
  }

  tau(tick: number): number {
    return Math.max(this.expiryTick - tick, 0);
  }

  refreshQuote(tick: number, qp: QuoteParams): void {
    const p = this.engine.pYes();
    this.quote = computeQuote(
      p,
      this.engine.qY - this.engine.qN,
      this.engine.effectiveB(),
      this.tau(tick),
      qp,
      this.tenorLabel
    );
  }

  // Marketable order vs the ENGINE — moves price. side = what user buys.
  // Returns the cash the buyer paid (engine-curve cost + spread) so callers can
  // book the exact amount and reconcile against the house's cashCollected.
  executeEngineBuy(
    side: Side,
    shares: number,
    actor: string,
    tick: number,
    lockoutTicks?: number
  ): number {
    if (shares <= 0) return 0;
    // Final-window lockout: near expiry accept only inventory-REDUCING trades so
    // the house stops accumulating toxic inventory at the gamma wall. A YES buy
    // raises netSkew (qY−qN); a NO buy lowers it. Reject if it grows |netSkew|.
    // Use the explicit param if given, otherwise fall back to the per-market
    // lockout (set by MarketManager per tenor; the 5m gets a longer window
    // because its gamma wall is the sharpest).
    const effectiveLockout = lockoutTicks ?? this.lockoutTicks;
    const tau = this.tau(tick);
    if (effectiveLockout > 0 && tau > 0 && tau <= effectiveLockout) {
      const netSkew = this.engine.qY - this.engine.qN;
      const newSkew = netSkew + (side === 'YES' ? shares : -shares);
      if (Math.abs(newSkew) > Math.abs(netSkew)) return 0; // reduce-only: blocked
    }
    const half = (this.quote.ask - this.quote.bid) / 2;
    const engineCash = this.engine.applyBuy(side, shares);
    const spread = shares * Math.max(half, 0);
    const paid = engineCash + spread;
    this.cashCollected += paid;
    this.spreadCapture += spread;
    const px = paid / shares;
    this.print({ tick, side, shares, price: px, channel: 'engine', actor });
    return paid;
  }

  // Resting limit order (may later pair-mint or be hit by the engine quote).
  postLimit(o: RestingOrder): void {
    this.restingBids.push(o);
  }

  // User<->user pair-mint: match best YES bid + best NO bid when prices cross
  // ($1 pair). Price-neutral: no engine state change, no house cash.
  matchPairs(tick: number): void {
    let guard = 0;
    while (guard++ < 50) {
      const yes = this.bestBid('YES');
      const no = this.bestBid('NO');
      if (!yes || !no) break;
      if (yes.limitPrice + no.limitPrice < 1) break; // cannot mint a $1 pair
      const fill = Math.min(yes.shares, no.shares);
      yes.shares -= fill;
      no.shares -= fill;
      this.print({
        tick,
        side: 'YES',
        shares: fill,
        price: yes.limitPrice,
        channel: 'pair-mint',
        actor: yes.actor,
      });
      this.restingBids = this.restingBids.filter((o) => o.shares > 1e-9);
    }
  }

  private bestBid(side: Side): RestingOrder | undefined {
    let best: RestingOrder | undefined;
    for (const o of this.restingBids) {
      if (o.side !== side) continue;
      if (!best || o.limitPrice > best.limitPrice) best = o;
    }
    return best;
  }

  private print(t: TradePrint): void {
    this.lastTrades.unshift(t);
    if (this.lastTrades.length > MAX_PRINTS) this.lastTrades.pop();
  }

  // Settlement: realise inventory P&L into cashCollected (design-rules.md Q4).
  settle(outcomeYes: boolean): number {
    const payout = this.engine.settlementLiability(outcomeYes);
    this.cashCollected -= payout;
    this.settled = true;
    return this.cashCollected; // realised market P&L
  }

  snapshot(tick: number): MarketSnapshot {
    return {
      id: this.id,
      tenorLabel: this.tenorLabel,
      strike: this.strike,
      createdTick: this.createdTick,
      expiryTick: this.expiryTick,
      tauTicks: this.tau(tick),
      qY: this.engine.qY,
      qN: this.engine.qN,
      pYes: this.engine.pYes(),
      bid: this.quote.bid,
      ask: this.quote.ask,
      reservation: this.quote.reservation,
      netSkew: this.engine.qY - this.engine.qN,
      cashCollected: this.cashCollected,
      liquidityB: this.engine.effectiveB(),
      lastTrades: this.lastTrades,
      restingBids: this.restingBids,
    };
  }
}

// Rounds a strike to a clean BTC increment (Q2 micro-default: nearest $100).
function roundStrike(x: number): number {
  return Math.round(x / 100) * 100;
}

export class MarketManager {
  markets: Market[] = [];
  private seq = 0;
  // Per-tenor reduce-only lockout in ticks. The 5m gets a longer window
  // (60s default) because its digital-gamma wall is the sharpest; other
  // tenors get the default (30s). Set lockoutTicksByTenor to {} for the
  // legacy "all tenors get default" behaviour.
  private lockoutTicksByTenor: Record<string, number>;
  private defaultLockoutTicks: number;

  constructor(
    private tenors: { label: string; ticks: number }[],
    private strikePcts: number[],
    private engineParams: EngineParams,
    opts?: { defaultLockoutTicks?: number; lockoutTicksByTenor?: Record<string, number> }
  ) {
    this.defaultLockoutTicks = opts?.defaultLockoutTicks ?? 0;
    this.lockoutTicksByTenor = opts?.lockoutTicksByTenor ?? {};
  }

  // (re)seed every tenor's strike ladder around the current spot.
  seedAll(tick: number, spot: number): void {
    this.markets = [];
    for (const t of this.tenors) this.spawnCohort(t, tick, spot);
  }

  setEngine(params: EngineParams, tick: number, spot: number): void {
    this.engineParams = params;
    this.seedAll(tick, spot); // engine switch resets inventory (research sim)
  }

  private spawnCohort(
    t: { label: string; ticks: number },
    tick: number,
    spot: number
  ): void {
    const lockout = this.lockoutTicksByTenor[t.label] ?? this.defaultLockoutTicks;
    for (const pct of this.strikePcts) {
      const strike = roundStrike(spot * (1 + pct));
      const m = new Market(
        `${t.label}-${strike}-${this.seq++}`,
        t.label,
        strike,
        tick,
        tick + t.ticks,
        this.engineParams
      );
      m.lockoutTicks = lockout;
      this.markets.push(m);
    }
  }

  // Settle expired markets and respawn fresh cohorts (rolling tenors).
  // Returns the settled markets so the caller can accumulate realised P&L.
  roll(tick: number, spot: number): Market[] {
    const expired = this.markets.filter((m) => tick >= m.expiryTick);
    // ≥ matches the displayed contract ("Will BTC be ≥ strike?") — ties pay YES.
    for (const m of expired) m.settle(spot >= m.strike);
    if (expired.length) {
      const tenorsToRespawn = new Set(expired.map((m) => m.tenorLabel));
      this.markets = this.markets.filter((m) => tick < m.expiryTick);
      for (const t of this.tenors) {
        if (tenorsToRespawn.has(t.label)) this.spawnCohort(t, tick, spot);
      }
    }
    return expired;
  }
}
