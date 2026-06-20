// Agents ARE the market (docs/agents.md): they generate all flow, volume and
// skew. Intentionally simple for v1; meant to be retuned once observable.
//
// Epistemics (golden rule #6): directional & arb agents see the observable
// spot and the ESTIMATED sigma only — never the true GBM sigma.

import { RNG } from './rng';
import { digitalProb } from './events';
import type { Market } from './market';
import type { Side } from './types';

export interface AgentContext {
  rng: RNG;
  markets: Market[];
  spot: number;
  estSigma: number;
  recentDrift: number; // smoothed sign of synthetic trend
  tick: number;
  noiseIntensity: number;
  directionalIntensity: number;
  arbIntensity: number;
}

export function runAgents(ctx: AgentContext): void {
  const { rng, markets } = ctx;
  if (markets.length === 0) return;

  // ---- Noise traders: baseline volume + resting orders that pair-mint ----
  const noiseOrders = Math.round(ctx.noiseIntensity * markets.length * 0.5);
  for (let i = 0; i < noiseOrders; i++) {
    if (!rng.chance(0.7)) continue;
    const m = rng.pick(markets);
    const side: Side = rng.chance(0.5) ? 'YES' : 'NO';
    const size = rng.uniform(1, 8);
    if (rng.chance(0.45)) {
      // marketable: hit the engine
      m.executeEngineBuy(side, size, 'noise', ctx.tick);
    } else {
      // resting limit just inside the mid -> feeds the pair-mint channel
      const p = m.engine.pYes();
      const lim =
        side === 'YES'
          ? Math.min(0.99, p + rng.uniform(0, 0.04))
          : Math.min(0.99, 1 - p + rng.uniform(0, 0.04));
      m.postLimit({ side, limitPrice: lim, shares: size, actor: 'noise' });
    }
  }

  // ---- Directional / informed: lean with the synthetic trend -> skew ----
  if (Math.abs(ctx.recentDrift) > 1e-9) {
    const dirOrders = Math.round(ctx.directionalIntensity * markets.length * 0.4);
    const leanYes = ctx.recentDrift > 0;
    for (let i = 0; i < dirOrders; i++) {
      if (!rng.chance(0.6)) continue;
      const m = rng.pick(markets);
      const size = rng.uniform(2, 10) * Math.min(1, Math.abs(ctx.recentDrift) * 50);
      if (size < 0.5) continue;
      m.executeEngineBuy(leanYes ? 'YES' : 'NO', size, 'directional', ctx.tick);
    }
  }

  // ---- Arbitrageurs: trade the quote vs model-implied fair value ----
  // Fair P(YES) = digital prob under observable spot + ESTIMATED sigma.
  // Price discovery + keeps the engine from sitting stale (cold-start caveat).
  for (const m of markets) {
    if (ctx.arbIntensity <= 0) continue;
    const tau = m.tau(ctx.tick);
    if (tau <= 0) continue;
    const fair = digitalProb(ctx.spot, m.strike, ctx.estSigma, tau).p;
    const askYes = m.quote.ask; // cost to buy YES
    const bidYes = m.quote.bid; // selling YES == buying NO at (1-bid)
    const edgeBuyYes = fair - askYes; // >0 => YES underpriced
    const edgeBuyNo = bidYes - fair; // >0 => NO underpriced
    const threshold = 0.005; // must clear spread/friction to act
    if (edgeBuyYes > threshold) {
      const size = ctx.arbIntensity * edgeBuyYes * m.engine.effectiveB() * 0.18;
      if (size > 0.2) m.executeEngineBuy('YES', size, 'arb', ctx.tick);
    } else if (edgeBuyNo > threshold) {
      const size = ctx.arbIntensity * edgeBuyNo * m.engine.effectiveB() * 0.18;
      if (size > 0.2) m.executeEngineBuy('NO', size, 'arb', ctx.tick);
    }
  }

  // resolve any newly-crossable resting orders (pair-mint)
  for (const m of markets) m.matchPairs(ctx.tick);
}
