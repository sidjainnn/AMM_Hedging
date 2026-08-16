// Agent layer with a swappable model so we can roll back to the original simple
// agents at any time (design-rules.md: "agents meant to be retuned after the system
// is observable"). Both models reference the observable spot (live Binance) +
// ESTIMATED sigma; the AMM engine still prices off inventory, not the feed
// (golden rule #6: deployment logic uses est-σ / own-flow only).

import { RNG } from '../rng';
import type { Market } from '../market';
import type { AgentStats, MarketSentiment } from '../types';
import { SimpleAgents } from './simple';
import { BehavioralAgents } from './behavioral';

export type { AgentStats, MarketSentiment };

export type AgentModel = 'simple' | 'behavioral';

export interface AgentContext {
  markets: Market[];
  spot: number;
  estSigma: number;
  recentDrift: number; // smoothed sign of synthetic trend
  tick: number;
  noiseIntensity: number;
  directionalIntensity: number;
  arbIntensity: number;
  lockoutTicks: number; // reduce-only window before expiry (0 = off)
}

export interface AgentEngine {
  step(ctx: AgentContext): void;
  // optional wallet/reward hooks (behavioral model only)
  onSettled?(markets: Market[], spot: number): void;
  stats?(markets?: Market[]): AgentStats; // markets let it mark open positions
  sentiment?(): MarketSentiment;
}

export function makeAgents(model: AgentModel, rng: RNG): AgentEngine {
  return model === 'behavioral'
    ? new BehavioralAgents(rng)
    : new SimpleAgents(rng);
}
