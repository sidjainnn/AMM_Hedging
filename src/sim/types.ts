// Shared types: engine -> markets -> hedging -> UI all import from here.

export type EngineKind = 'LMSR' | 'CPMM' | 'LS-LMSR';
export type QuotingMode = 'manual' | 'stoikov';
export type Side = 'YES' | 'NO';

// Provenance tag for golden rule #6 honesty.
export type Provenance = 'sim-ground-truth' | 'deployment-available';

export interface EngineParams {
  kind: EngineKind;
  b0: number; // LMSR / LS-LMSR base liquidity
  alpha: number; // LS-LMSR liquidity scaling
  cpmmK?: number; // CPMM invariant seed
}

export interface QuoteParams {
  mode: QuotingMode;
  manualHalfSpread: number; // s/2 in probability units
  gamma: number; // Stoikov risk aversion
  sigma: number; // Stoikov vol input (user slider)
  k: number; // Stoikov order-arrival depth
}

// A single binary market: "BTC(t+τ) > K", one strike, one tenor instance.
export interface MarketSnapshot {
  id: string;
  tenorLabel: string; // '5m' | '10m' | '30m' | '1h'
  strike: number;
  createdTick: number;
  expiryTick: number;
  tauTicks: number; // ticks remaining
  qY: number; // outstanding YES shares the house is short
  qN: number; // outstanding NO shares the house is short
  pYes: number; // engine implied P(YES)
  bid: number; // displayed YES bid (quoting overlay)
  ask: number; // displayed YES ask
  reservation: number; // Stoikov reservation price (else = mid)
  netSkew: number; // qY - qN
  cashCollected: number; // premiums net of payouts so far
  liquidityB: number; // effective b (after LS scaling)
  lastTrades: TradePrint[];
  restingBids: RestingOrder[];
}

export interface TradePrint {
  tick: number;
  side: Side;
  shares: number;
  price: number; // execution price per share
  channel: 'engine' | 'pair-mint';
  actor: string;
}

export interface RestingOrder {
  side: Side;
  limitPrice: number;
  shares: number;
  actor: string;
}

export type HedgeBookId = 'A' | 'B' | 'C';

export interface HedgeBookState {
  id: HedgeBookId;
  label: string;
  targetUnits: number; // desired signed BTC units (+long)
  positionUnits: number; // actual held
  avgEntry: number;
  realizedPnl: number;
  unrealizedPnl: number;
  fees: number;
  funding: number;
  netPnl: number;
  // P&L decomposition (CLAUDE.md hedging.md): four components.
  spreadCapture: number;
  inventoryPnl: number;
  hedgePnl: number;
  fundingAccrued: number;
}

export interface HedgeActivity {
  tick: number;
  book: HedgeBookId;
  deltaUnits: number;
  markPrice: number;
  fee: number;
}

export interface PnlPoint {
  tick: number;
  btc: number;
  A: number;
  B: number;
  C: number;
  // components (Book A) for the decomposition toggle
  spreadCapture: number;
  inventoryPnl: number;
  hedgePnl: number;
  funding: number;
}

export interface SimConfig {
  seed: number;
  tickMs: number;
  engine: EngineParams;
  quote: QuoteParams;
  // synthetic BTC GBM (sim-ground-truth). When externalPrice is true the GBM is
  // bypassed and a live feed drives the price instead (deployment-available).
  externalPrice?: boolean;
  btcStart: number;
  btcVolPerTick: number; // TRUE sigma
  btcDriftPerTick: number;
  jumpChance: number;
  jumpSize: number;
  // strike ladder
  strikePcts: number[]; // e.g. [-0.03,-0.02,-0.01,0.01,0.02,0.03]
  tenors: { label: string; ticks: number }[];
  // agents
  agentModel: 'simple' | 'behavioral';
  noiseIntensity: number;
  directionalIntensity: number;
  arbIntensity: number;
  // hedging
  hedgeDialB: number; // h for Book B
  kFlat: number; // σ√τ flatten threshold
  feeBps: number; // hedge trade fee
  fundingRate8h: number; // ±% per 8h
}

export interface SimState {
  tick: number;
  btc: number;
  btcSeries: { tick: number; btc: number; provenance: Provenance }[];
  estSigma: number; // EWMA realized vol (deployment-available)
  markets: MarketSnapshot[];
  books: HedgeBookState[];
  aggregateDelta: number;
  pnlSeries: PnlPoint[];
  hedgeLog: HedgeActivity[];
  tauStar: number; // current flatten threshold in ticks (approx)
  agentStats?: AgentStats;
  sentiment?: MarketSentiment;
}

export interface MarketSentiment {
  pSent: number; // skill-weighted implied P(YES) — "smart money" probability
  lean: number; // -1..+1 net directional lean (+ = bullish BTC)
  weight: number; // total skill-weighted open interest behind the signal
  informedLean: number; // lean restricted to currently-profitable traders
}

export interface AgentStats {
  count: number;
  active: number;
  bankrupt: number;
  winners: number;
  totalBalance: number;
  avgBalance: number;
  richest: number;
}
