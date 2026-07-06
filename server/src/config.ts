import 'dotenv/config';

// Production hosts are hard-blocked so this can never touch real money.
const MAINNET_HOSTS = ['api.binance.com', 'fapi.binance.com', 'api1.binance.com', 'api2.binance.com', 'api3.binance.com'];

function assertPaper(base: string, label: string): string {
  let host: string;
  try {
    host = new URL(base).host;
  } catch {
    throw new Error(`Invalid ${label} URL: ${base}`);
  }
  if (MAINNET_HOSTS.includes(host)) {
    throw new Error(
      `REFUSING TO START: ${label}=${base} is a PRODUCTION (real-money) host. ` +
        `This build only allows demo/testnet venues.`
    );
  }
  return base;
}

const env = process.env;

export const config = {
  apiKey: env.BINANCE_API_KEY ?? '',
  apiSecret: env.BINANCE_API_SECRET ?? '',
  spotBase: assertPaper(env.SPOT_BASE ?? 'https://demo-api.binance.com', 'SPOT_BASE'),
  futuresBase: assertPaper(env.FUTURES_BASE ?? 'https://demo-fapi.binance.com', 'FUTURES_BASE'),
  symbol: (env.SYMBOL ?? 'BTCUSDT').toUpperCase(),
  port: parseInt(env.PORT ?? '8787', 10),
  dryRun: (env.DRY_RUN ?? 'true').toLowerCase() !== 'false',
  hedgeEnabled: (env.HEDGE_ENABLED ?? 'false').toLowerCase() === 'true',
  maxPositionBtc: parseFloat(env.MAX_POSITION_BTC ?? '0.05'),
  // Full demo budget: cap hedge notional at this many USDT (≈ the whole 10k).
  // The BTC cap is derived dynamically as maxNotionalUsdt / markPrice.
  maxNotionalUsdt: parseFloat(env.MAX_NOTIONAL_USDT ?? '10000'),
  hedgeIntervalSec: parseInt(env.HEDGE_INTERVAL_SEC ?? '10', 10),
  // 'delta' = neutralise the MM book's skew (Book C); 'sentiment' = directional
  // perp from the smart-money signal; 'combined' = delta hedge + sentiment tilt.
  hedgeMode: (env.HEDGE_MODE ?? 'combined') as 'delta' | 'sentiment' | 'combined',
  // at sentiment lean = ±1, hold sentimentGain × the notional cap.
  sentimentGain: parseFloat(env.SENTIMENT_GAIN ?? '1'),
  // --- Volatility gate -------------------------------------------------------
  // Hedging only pays when the BTC move is large relative to the round-trip fee
  // cost; in calm markets a hedge is pure fee bleed (see the Hedge Risk Lab).
  // So only hedge once realized vol breaches a threshold, and flatten when it
  // calms. Realized vol = stdev of per-tick simple returns over volWindow ticks.
  // Default OFF for live: measured 1s BTC realizedVol sits ~4e-5 and is nearly
  // flat, so an absolute vol gate either never arms or always arms — no usable
  // threshold. The INVENTORY gate (below) has real range and does the gating.
  // Opt in with HEDGE_VOL_GATE=true (e.g. for a volatile session / longer window).
  hedgeVolGate: (env.HEDGE_VOL_GATE ?? 'false').toLowerCase() === 'true',
  hedgeVolWindow: parseInt(env.HEDGE_VOL_WINDOW ?? '60', 10), // ticks (≈1s each)
  // turn hedging ON when realized per-tick return stdev ≥ this. Live 1s BTC vol
  // sits ~0.0001 and is nearly flat, so an absolute vol gate is a knife-edge —
  // default low (0.0002) and lean on the inventory gate; tune live from the 5m
  // page. Set HEDGE_VOL_GATE=false to disable it and gate on inventory only.
  hedgeVolThreshold: parseFloat(env.HEDGE_VOL_THRESHOLD ?? '0.0002'),
  // hysteresis: stay ON until vol drops below threshold × this (avoids flapping).
  hedgeVolHysteresis: parseFloat(env.HEDGE_VOL_HYSTERESIS ?? '0.6'),
  // --- Inventory gate + risk-tier (override the sim defaults for live) --------
  // Below this notional exposure (|aggregate δ|×spot, USDT) the live hedger stays
  // flat (no fee churn); above it the sim's risk-tier ramps the hedge. Override
  // so ops can RECALIBRATE the live gate to observed exposure WITHOUT recompiling
  // — the sim flow is simulated, so the synthetic-tuned $200 may not match live
  // agent-driven notional. Applied to the runner's sim via setters at startup.
  hedgeNotionalUsdt: parseFloat(env.HEDGE_NOTIONAL_USDT ?? '80'),
  // Gate mode. 'adaptive' (default): the inventory gate self-calibrates to a
  // PERCENTILE of the last hour's notional-exposure distribution (floored at
  // hedgeNotionalUsdt) — "hedge only the riskiest X% of periods" stays true in
  // any regime (BTC price level, flow mix), no manual retuning. 'fixed': use
  // hedgeNotionalUsdt as an absolute threshold (the 5m-page tune input
  // switches to this mode).
  hedgeGateMode: (env.HEDGE_GATE_MODE ?? 'adaptive') as 'adaptive' | 'fixed',
  // adaptive mode: gate at this percentile of recent exposure (0.6 = hedge
  // roughly the top-40% exposure periods).
  hedgeGatePctl: parseFloat(env.HEDGE_GATE_PCTL ?? '0.6'),
  riskTierLow: parseFloat(env.HEDGE_TIER_LOW ?? '0.3'),
  riskTierHigh: parseFloat(env.HEDGE_TIER_HIGH ?? '0.7'),
  // Perp leverage for the hedge symbol. Default 1x — a hedge wants no leverage.
  leverage: parseInt(env.HEDGE_LEVERAGE ?? '1', 10),
  // Multi-Assets Mode ON so USDC + USDT together back the BTCUSDT hedge (~10k).
  multiAssets: (env.MULTI_ASSETS_MARGIN ?? 'true').toLowerCase() === 'true',
  // A/B scheduler: when running, hedging toggles automatically at 5m-window
  // boundaries — abBlocksOn hedged windows, then abBlocksOff unhedged
  // (validation) windows, repeating. Started via API/UI, never on boot.
  abBlocksOn: parseInt(env.AB_BLOCKS_ON ?? '6', 10),
  abBlocksOff: parseInt(env.AB_BLOCKS_OFF ?? '2', 10),
  // Stale-feed guard: if Binance hasn't answered for this many seconds, FREEZE
  // market time (no sim steps → no settlements on a frozen price) until it
  // recovers. Markets that expire during an outage settle on the first fresh
  // price after recovery (honest, just delayed).
  feedStaleSec: parseInt(env.FEED_STALE_SEC ?? '15', 10),
  hasKeys(): boolean {
    return this.apiKey.length > 0 && this.apiSecret.length > 0;
  },
};
