import type { SimConfig } from './types';

// Time model (design-rules.md Q3): real-time loop, fixed tick. τ-based calcs use
// elapsed ticks. Default 1s/tick; tenors expressed in ticks accordingly.
export const TICKS_PER_8H = (8 * 3600 * 1000) / 1000; // at 1s/tick

export const defaultConfig: SimConfig = {
  seed: 42,
  tickMs: 250, // sim runs 4x display speed; τ still measured in ticks
  // BTC price now comes from the live Binance feed (synthetic GBM off).
  // Headless tools (backtest/validate) override this back to false.
  externalPrice: true,
  // b0=110: the LMSR loss bound is b·ln2 per resolved market (~76 here) — the
  // liquidity *subsidy* the house pays for inventory-based price discovery. The vig
  // (spread) must out-earn it to break even, so b is kept moderate.
  engine: { kind: 'LMSR', b0: 110, alpha: 0.05, cpmmK: 110 },
  quote: {
    mode: 'stoikov',
    manualHalfSpread: 0.01,
    gamma: 1.0,
    sigma: 0.05,
    // k sets the adverse-selection half-spread (~2/k). With one ATM market per
    // tenor, k=25 did NOT break even (spread ≈ inventory subsidy + hedge cost);
    // k=12 clears it with margin (~+$71/5m-window, 95% of windows ≥0 in QA).
    // Lower k = wider spread = more margin but less competitive. See
    // src/sim/breakeven.ts and docs/hedging-validation-and-qa.md.
    k: 12,
    // charge for the unhedgeable digital gamma: widen the spread into expiry
    // near the strike (peaks ATM). Tuned with src/sim/breakeven.ts.
    gammaWiden: 0.03,
    // Inventory-proportional widening: half-spread scales with |netSkew|/b.
    // 0 at flat inventory (keeps quotes competitive — flow keeps flowing);
    // grows as the house accumulates one-sided inventory, paying users to
    // close the gap before it gets risky. 0.015 = ~1.5¢ extra half-spread per
    // unit of (qY-qN)/b.
    invWiden: 0.015,
    // 5m market gets a 50% bigger invWiden multiplier (its gamma wall is the
    // sharpest of the three tenors). The 5m is the optimisation target.
    invWiden5mBoost: 1.5,
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
  // AMM maker viable, so noise dominates the default mix.
  noiseIntensity: 2.5,
  directionalIntensity: 0.7,
  arbIntensity: 0.7,
  hedgeDialB: 0.5,
  kFlat: 0.02,
  feeBps: 2,
  fundingRate8h: 0.01,
  // last 30s of each market (1 tick = 1s): reduce-only, no new toxic inventory
  // at the gamma wall. Pairs with quote.gammaWiden to keep the MM at break-even.
  expiryLockoutTicks: 30,
  // 5m market gets 60s (its gamma wall is the sharpest of the three tenors).
  expiryLockoutTicks5m: 60,
  // Risk-tier hedge dial: below this notional exposure (|aggregate δ|×spot, USDT)
  // the hedge is gated off for Books A/C — no fee churn in flat regimes. Above
  // it, h ramps through (tierLow, tierHigh, 1.0) as exposure grows. Saves
  // round-trip fees in calm windows; preserves tail protection in risky ones.
  hedgeNotionalUsdt: 200,
  riskTierLow: 0.3,
  riskTierHigh: 0.7,
};
