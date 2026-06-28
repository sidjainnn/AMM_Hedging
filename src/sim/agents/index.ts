// Agent layer with a swappable model so we can roll back to the original simple
// agents at any time (CLAUDE.md: "agents meant to be retuned after the system
// is observable"). Both models are feed-free in the pricing sense: they may
// reference the synthetic spot + ESTIMATED sigma (sim ground truth / deployment-
// available per golden rule #6) but never feed an external data source.

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
}

export interface AgentEngine {
  step(ctx: AgentContext): void;
  // optional wallet/reward hooks (behavioral model only)
  onSettled?(markets: Market[], spot: number): void;
  stats?(): AgentStats;
  sentiment?(): MarketSentiment;
}

export function makeAgents(model: AgentModel, rng: RNG): AgentEngine {
  return model === 'behavioral'
    ? new BehavioralAgents(rng)
    : new SimpleAgents(rng);
}
