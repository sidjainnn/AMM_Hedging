import type { SimConfig } from './types';

// Time model (CLAUDE.md Q3): real-time loop, fixed tick. τ-based calcs use
// elapsed ticks. Default 1s/tick; tenors expressed in ticks accordingly.
export const TICKS_PER_8H = (8 * 3600 * 1000) / 1000; // at 1s/tick

export const defaultConfig: SimConfig = {
  seed: 42,
  tickMs: 250, // sim runs 4x display speed; τ still measured in ticks
  // BTC price now comes from the live Binance feed (synthetic GBM off).
  // Headless tools (backtest/validate) override this back to false.
  externalPrice: true,
  // b0=110: the LMSR loss bound is b·ln2 per resolved market (~76 here) — the
  // liquidity *subsidy* the house pays for feed-free price discovery. The vig
  // (spread) must out-earn it to break even, so b is kept moderate.
  engine: { kind: 'LMSR', b0: 110, alpha: 0.05, cpmmK: 110 },
  quote: {
    mode: 'stoikov',
    manualHalfSpread: 0.01,
    gamma: 1.0,
    sigma: 0.05,
    // k≈25 sets the adverse-selection half-spread (~2/k) wide enough that
    // spread capture covers the subsidy + adverse selection → break-even+.
    k: 25,
  },
  btcStart: 68000,
  btcVolPerTick: 0.0011, // TRUE sigma per tick
  btcDriftPerTick: 0.000002,
  jumpChance: 0.01,
  jumpSize: 0.01,
  // one ATM market per tenor (strike = spot at creation, refreshed each roll)
  strikePcts: [0],
  tenors: [
    { label: '5m', ticks: 300 },
    { label: '10m', ticks: 600 },
    { label: '30m', ticks: 1800 },
  ],
  // 'behavioral' = heterogeneous trader population; 'simple' = original v1
  // agents (rollback). Switchable live from the Trading page.
  agentModel: 'behavioral',
  // Noise is symmetric churn → pays spread without net price displacement, so
  // it earns vig "for free". Directional/arb cause displacement = subsidy +
  // adverse selection (the cost). A healthy noise:toxic ratio is what makes a
  // feed-free maker viable, so noise dominates the default mix.
  noiseIntensity: 2.5,
  directionalIntensity: 0.7,
  arbIntensity: 0.7,
  hedgeDialB: 0.5,
  kFlat: 0.02,
  feeBps: 2,
  fundingRate8h: 0.01,
};
