// Behavioral agents — a persistent, heterogeneous population calibrated to
// documented prediction-market / retail-trading stylized facts. Informed traders
// reference the observable spot (live Binance) + ESTIMATED sigma only
// (deployment-available); the AMM engine still prices off inventory, not the feed.
//
// Replicated regularities:
//   - persistent population reused across markets (repeat behaviour)
//   - bursty arrivals: activity spikes on price moves & near expiry
//   - heavy-tailed order sizes (lognormal): mostly small, rare whales
//   - archetypes: noise / momentum / contrarian / informed
//   - behavioural biases: favorite-longshot, momentum chasing, mean-reversion
//   - patience: impatient cross the spread (engine), patient post limits (pair-mint)
//
// The three intensity sliders still work: noise→noise, directional→momentum+
// contrarian, arb→informed.

import { RNG } from '../rng';
import { digitalProb } from '../events';
import { clamp } from '../math';
import type { Market } from '../market';
import type { Side } from '../types';
import type { AgentContext, AgentEngine } from './index';

type Archetype = 'noise' | 'momentum' | 'contrarian' | 'informed';

interface Trader {
  archetype: Archetype;
  activity: number; // base prob of acting per tick
  sizeScale: number; // median order size (heavy-tailed)
  patience: number; // 0..1, higher = more likely to post a limit
  longshot: number; // 0..1, favorite-longshot bias strength
  riskAversion: number; // scales size down
  // --- wallet / reward state ---
  balance: number; // finite cash; the reward signal
  startBalance: number;
  positions: Record<string, { yes: number; no: number; cost: number }>; // by marketId
}

// Below this cash an agent is broke and drops out of the flow (the penalty).
const MIN_BALANCE = 15;

// Each trade risks a fraction of the agent's bankroll (bankroll management) —
// this is what makes the wallet the behavioural driver: balances compound up for
// winners and bleed to zero for losers.
const ARCH_RISK: Record<Archetype, number> = {
  noise: 0.03,
  momentum: 0.05,
  contrarian: 0.045,
  informed: 0.06,
};

const POP = 95;
const WEIGHTS: Record<Archetype, number> = {
  noise: 0.5,
  momentum: 0.22,
  contrarian: 0.13,
  informed: 0.15,
};

// Baseline order-arrival rate: expected trades per tick across ALL markets in a
// calm market. Real prediction markets are sporadic, so this is well below 1 —
// most calm ticks have NO trade. Volatility & near-expiry multiply it.
const BASE_RATE = 0.3;

// Knuth's Poisson sampler (seeded via the provided RNG → deterministic).
function poisson(rng: RNG, lambda: number): number {
  if (lambda <= 0) return 0;
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng.next();
  } while (p > L);
  return k - 1;
}

export class BehavioralAgents implements AgentEngine {
  private pop: Trader[];
  private startTotal: number;

  constructor(private base: RNG) {
    const r = base.derive('population');
    this.pop = Array.from({ length: POP }, () => this.makeTrader(r));
    this.startTotal = this.pop.reduce((a, t) => a + t.startBalance, 0);
  }

  private makeTrader(r: RNG): Trader {
    // archetype by cumulative weight
    const u = r.next();
    let acc = 0;
    let archetype: Archetype = 'noise';
    for (const a of Object.keys(WEIGHTS) as Archetype[]) {
      acc += WEIGHTS[a];
      if (u <= acc) {
        archetype = a;
        break;
      }
    }
    const lognormal = (mu: number, sigma: number) => Math.exp(r.normal(mu, sigma));
    const startBalance = clamp(lognormal(Math.log(150), 0.75), 30, 2000); // heterogeneous bankroll
    return {
      archetype,
      activity: clamp(lognormal(Math.log(0.12), 0.7), 0.01, 0.8),
      sizeScale: clamp(lognormal(Math.log(3.5), 0.9), 0.5, 80), // heavy tail
      patience: r.uniform(0, 1),
      longshot: r.uniform(0, 0.6),
      riskAversion: r.uniform(0.6, 1.4),
      balance: startBalance,
      startBalance,
      positions: {},
    };
  }

  step(ctx: AgentContext): void {
    const { markets } = ctx;
    if (markets.length === 0) return;
    const rng = this.base.derive(`behavioral-${ctx.tick}`);

    // Sporadic, bursty order flow (Poisson arrivals) — NOT one trade per tick.
    // Rate spikes with recent volatility and as the nearest market approaches
    // expiry; in calm periods most ticks see no trade at all.
    const vol = Math.abs(ctx.recentDrift);
    let minTau = Infinity;
    for (const m of markets) {
      const t = m.tau(ctx.tick);
      if (t > 0) minTau = Math.min(minTau, t);
    }
    const expiryBoost = isFinite(minTau) ? 1 + Math.max(0, (60 - minTau) / 30) : 1; // last ~minute ramp
    const burst = (1 + Math.min(8, vol * 250)) * expiryBoost;

    const archIntensity: Record<Archetype, number> = {
      noise: ctx.noiseIntensity,
      momentum: ctx.directionalIntensity,
      contrarian: ctx.directionalIntensity,
      informed: ctx.arbIntensity,
    };

    const intensityScale =
      ctx.noiseIntensity * 0.5 + ctx.directionalIntensity * 0.3 + ctx.arbIntensity * 0.2;
    const lambda = BASE_RATE * burst * intensityScale;
    const arrivals = poisson(rng, lambda);

    if (arrivals > 0) {
      // each arrival = one trader acts, chosen ∝ activity × archetype intensity
      // × wealth. Broke agents (balance<MIN) get weight 0 — they drop out of the
      // flow. Winners (balance>start) get picked more often: the reward signal.
      const weights = this.pop.map((t) => {
        if (t.balance < MIN_BALANCE) return 0;
        const wealthFactor = clamp(t.balance / t.startBalance, 0.2, 3);
        return t.activity * archIntensity[t.archetype] * wealthFactor;
      });
      const total = weights.reduce((a, b) => a + b, 0);
      if (total > 0) {
        for (let i = 0; i < arrivals; i++) {
          const t = this.pickTrader(rng, weights, total);
          if (t) this.act(t, ctx, rng);
        }
      }
    }

    for (const m of markets) m.matchPairs(ctx.tick);
  }

  // weighted random trader selection (roulette wheel)
  private pickTrader(rng: RNG, weights: number[], total: number): Trader | null {
    let r = rng.next() * total;
    for (let i = 0; i < this.pop.length; i++) {
      r -= weights[i];
      if (r <= 0) return this.pop[i];
    }
    return this.pop[this.pop.length - 1] ?? null;
  }

  private act(t: Trader, ctx: AgentContext, rng: RNG): void {
    const m = this.chooseMarket(t, ctx, rng);
    if (!m) return;
    const tau = m.tau(ctx.tick);
    if (tau <= 0) return;
    const p = m.engine.pYes();

    let side: Side;
    let marketable: boolean;
    // base bet sized as a fraction of the bankroll (~$0.5/share avg) → wealth-coupled
    let size = (t.balance * ARCH_RISK[t.archetype] * rng.uniform(0.5, 1.6)) / (0.5 * t.riskAversion);

    switch (t.archetype) {
      case 'informed': {
        // noisy edge vs model-implied fair (observable spot + est sigma)
        const fair = digitalProb(ctx.spot, m.strike, ctx.estSigma, tau).p;
        const edgeYes = fair - m.quote.ask;
        const edgeNo = m.quote.bid - fair;
        const friction = 0.004;
        if (edgeYes > friction && edgeYes >= edgeNo) {
          side = 'YES';
          size *= clamp(edgeYes / 0.02, 0.5, 3); // bet bigger on bigger edge
        } else if (edgeNo > friction) {
          side = 'NO';
          size *= clamp(edgeNo / 0.02, 0.5, 3);
        } else {
          return; // no edge -> no trade
        }
        marketable = true; // must cross to capture the edge
        break;
      }
      case 'momentum': {
        side = ctx.recentDrift >= 0 ? 'YES' : 'NO';
        size *= 1 + Math.min(2, Math.abs(ctx.recentDrift) * 80);
        marketable = rng.chance(0.65 + 0.3 * (1 - t.patience)); // chasers impatient
        break;
      }
      case 'contrarian': {
        // fade extreme prices (mean reversion)
        if (p > 0.58) side = 'NO';
        else if (p < 0.42) side = 'YES';
        else side = rng.chance(0.5) ? 'YES' : 'NO';
        marketable = rng.chance(0.3 * (1 - t.patience)); // patient -> limits
        break;
      }
      default: {
        // noise
        side = rng.chance(0.5) ? 'YES' : 'NO';
        marketable = rng.chance(1 - t.patience);
      }
    }

    size = clamp(size, 0.4, 200); // affordability is re-checked below for buys
    if (size < 0.4) return;

    if (marketable) {
      const price = side === 'YES' ? m.quote.ask : 1 - m.quote.bid;
      // finite wallet: cap to affordable cash, deduct, and record the position
      const affordable = Math.floor((t.balance / Math.max(price, 1e-4)) * 100) / 100;
      size = Math.min(size, affordable);
      if (size < 0.4) return; // can't afford to act
      // book the EXACT cash the engine charged (reconciles with the MM book).
      // Omit lockoutTicks so the per-tenor value (m.lockoutTicks: 60 for the 5m,
      // 30 for others) governs — passing ctx.lockoutTicks would override it.
      const cost = m.executeEngineBuy(side, size, t.archetype, ctx.tick);
      if (cost <= 0) return; // rejected (reduce-only lockout) — no fill, no book
      t.balance -= cost;
      const pos = t.positions[m.id] ?? { yes: 0, no: 0, cost: 0 };
      if (side === 'YES') pos.yes += size;
      else pos.no += size;
      pos.cost += cost;
      t.positions[m.id] = pos;
    } else {
      // resting limit just inside the displayed quote; longshot bias makes the
      // trader willing to pay up (post more aggressively) on cheap outcomes.
      // (liquidity-provision; not wallet-tracked for settlement in v1)
      const aggro = rng.uniform(0, 0.04) + t.longshot * rng.uniform(0, 0.05);
      const lim =
        side === 'YES'
          ? clamp(p + aggro, 0.01, 0.99)
          : clamp(1 - p + aggro, 0.01, 0.99);
      m.postLimit({ side, limitPrice: lim, shares: size, actor: t.archetype });
    }
  }

  // Market selection: informed hunt the biggest mispricing; others pick at
  // random but the favorite-longshot bias pulls them toward extreme strikes.
  private chooseMarket(t: Trader, ctx: AgentContext, rng: RNG): Market | null {
    const ms = ctx.markets;
    if (t.archetype === 'informed') {
      let best: Market | null = null;
      let bestEdge = 0;
      for (let i = 0; i < 5; i++) {
        const m = rng.pick(ms);
        const tau = m.tau(ctx.tick);
        if (tau <= 0) continue;
        const fair = digitalProb(ctx.spot, m.strike, ctx.estSigma, tau).p;
        const edge = Math.max(fair - m.quote.ask, m.quote.bid - fair);
        if (edge > bestEdge) {
          bestEdge = edge;
          best = m;
        }
      }
      return best ?? rng.pick(ms);
    }
    // favorite-longshot: sometimes prefer the more extreme-priced (cheaper) book
    if (rng.chance(t.longshot)) {
      const a = rng.pick(ms);
      const b = rng.pick(ms);
      const exA = Math.abs(a.engine.pYes() - 0.5);
      const exB = Math.abs(b.engine.pYes() - 0.5);
      return exA >= exB ? a : b;
    }
    return rng.pick(ms);
  }

  // Settlement: pay out each agent's positions in the settled markets ($1 per
  // winning share), credit their wallet, and clear the position. This is the
  // reward — good traders' balances grow, bad ones bleed toward broke.
  onSettled(markets: Market[], spot: number): void {
    for (const m of markets) {
      const outcomeYes = spot >= m.strike; // ≥ = displayed contract (ties pay YES)
      for (const t of this.pop) {
        const pos = t.positions[m.id];
        if (!pos) continue;
        const payout = outcomeYes ? pos.yes : pos.no; // $1 per winning share
        t.balance += payout;
        delete t.positions[m.id];
      }
    }
  }

  // Population wealth summary (the reward signal made visible). If `markets` are
  // given, each trader's EQUITY = cash + open positions marked at engine P(YES)
  // (so mid-window P&L isn't understated by cash spent on un-settled positions).
  stats(markets?: Market[]) {
    const pmark = new Map<string, number>();
    if (markets) for (const m of markets) pmark.set(m.id, m.engine.pYes());
    const equityOf = (t: Trader): number => {
      let eq = t.balance;
      if (markets) for (const id in t.positions) {
        const p = pmark.get(id);
        if (p !== undefined) eq += t.positions[id].yes * p + t.positions[id].no * (1 - p);
      }
      return eq;
    };
    let total = 0;
    let active = 0;
    let bankrupt = 0;
    let richest = 0;
    let winners = 0; // equity above their start
    for (const t of this.pop) {
      const eq = equityOf(t);
      total += eq;
      if (t.balance >= MIN_BALANCE) active++;
      else bankrupt++;
      if (eq > t.startBalance) winners++;
      richest = Math.max(richest, eq);
    }
    return {
      count: this.pop.length,
      active,
      bankrupt,
      winners,
      totalBalance: total,
      startTotal: this.startTotal,
      pnl: total - this.startTotal,
      avgBalance: total / this.pop.length,
      richest,
    };
  }

  // Information sentiment = SKILL-WEIGHTED net positioning ("smart money").
  // Each agent's YES/NO holdings are weighted by wealth-as-skill (winners count
  // more). Aggregated across the BTC binaries it gives a directional read that
  // tends to LEAD the engine price toward fair value. pSent in [0,1], lean in
  // [-1,1] (+ = smart money bullish on BTC). `informedShare` = fraction of the
  // weighted positioning held by traders currently in profit.
  sentiment() {
    let wYes = 0;
    let wNo = 0;
    let informedYes = 0;
    let informedNo = 0;
    for (const t of this.pop) {
      const skill = clamp(t.balance / t.startBalance, 0.2, 4);
      const winning = t.balance > t.startBalance;
      for (const id in t.positions) {
        const p = t.positions[id];
        wYes += skill * p.yes;
        wNo += skill * p.no;
        if (winning) {
          informedYes += skill * p.yes;
          informedNo += skill * p.no;
        }
      }
    }
    const tot = wYes + wNo;
    const infTot = informedYes + informedNo;
    return {
      pSent: tot > 0 ? wYes / tot : 0.5,
      lean: tot > 0 ? (wYes - wNo) / tot : 0,
      weight: tot,
      informedLean: infTot > 0 ? (informedYes - informedNo) / infTot : 0,
    };
  }
}
