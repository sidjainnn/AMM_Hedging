// Behavioral agents — a persistent, heterogeneous population calibrated to
// documented prediction-market / retail-trading stylized facts. Still fully
// feed-free: informed traders reference the observable spot + ESTIMATED sigma
// only (deployment-available); nothing reads an external data feed.
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
}

const POP = 95;
const WEIGHTS: Record<Archetype, number> = {
  noise: 0.5,
  momentum: 0.22,
  contrarian: 0.13,
  informed: 0.15,
};

export class BehavioralAgents implements AgentEngine {
  private pop: Trader[];

  constructor(private base: RNG) {
    const r = base.derive('population');
    this.pop = Array.from({ length: POP }, () => this.makeTrader(r));
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
    return {
      archetype,
      activity: clamp(lognormal(Math.log(0.12), 0.7), 0.01, 0.8),
      sizeScale: clamp(lognormal(Math.log(3.5), 0.9), 0.5, 80), // heavy tail
      patience: r.uniform(0, 1),
      longshot: r.uniform(0, 0.6),
      riskAversion: r.uniform(0.6, 1.4),
    };
  }

  step(ctx: AgentContext): void {
    const { markets } = ctx;
    if (markets.length === 0) return;
    const rng = this.base.derive(`behavioral-${ctx.tick}`);

    // bursty arrivals: activity rises with recent volatility
    const burst = 1 + Math.min(3, Math.abs(ctx.recentDrift) * 120);

    const archIntensity: Record<Archetype, number> = {
      noise: ctx.noiseIntensity,
      momentum: ctx.directionalIntensity,
      contrarian: ctx.directionalIntensity,
      informed: ctx.arbIntensity,
    };

    for (const t of this.pop) {
      const pAct = clamp(t.activity * burst * archIntensity[t.archetype] * 0.95, 0, 0.97);
      if (!rng.chance(pAct)) continue;
      this.act(t, ctx, rng);
    }

    for (const m of markets) m.matchPairs(ctx.tick);
  }

  private act(t: Trader, ctx: AgentContext, rng: RNG): void {
    const m = this.chooseMarket(t, ctx, rng);
    if (!m) return;
    const tau = m.tau(ctx.tick);
    if (tau <= 0) return;
    const p = m.engine.pYes();

    let side: Side;
    let marketable: boolean;
    let size = t.sizeScale * rng.uniform(0.5, 1.8) / t.riskAversion;

    switch (t.archetype) {
      case 'informed': {
        // noisy edge vs model-implied fair (observable spot + est sigma)
        const fair = digitalProb(ctx.spot, m.strike, ctx.estSigma, tau).p;
        const edgeYes = fair - m.quote.ask;
        const edgeNo = m.quote.bid - fair;
        const friction = 0.004;
        if (edgeYes > friction && edgeYes >= edgeNo) {
          side = 'YES';
          size = edgeYes * m.engine.effectiveB() * 0.45 * ctx.arbIntensity;
        } else if (edgeNo > friction) {
          side = 'NO';
          size = edgeNo * m.engine.effectiveB() * 0.45 * ctx.arbIntensity;
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

    size = clamp(size, 0.4, 90);
    if (size < 0.4) return;

    if (marketable) {
      m.executeEngineBuy(side, size, t.archetype, ctx.tick);
    } else {
      // resting limit just inside the displayed quote; longshot bias makes the
      // trader willing to pay up (post more aggressively) on cheap outcomes.
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
}
