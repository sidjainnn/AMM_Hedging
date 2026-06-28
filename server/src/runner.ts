import { Simulation } from '../../src/sim/sim';
import { defaultConfig } from '../../src/sim/config';
import { getSpotPrice, getFuturesMarkPrice, getAccount, type FuturesAccount } from './binance';
import { Hedger } from './hedger';
import { config } from './config';

// Runs the sim off the live feed and hedges on Binance demo perps. Two modes:
//   delta     — neutralise the MM book's settlement-value delta (Book C)
//   sentiment — take a directional perp position from the prediction-market
//               smart-money signal (skill-weighted agent positioning)
// Tracks the real futures account equity over time so we can SEE whether the
// concept works.
export class Runner {
  private sim: Simulation;
  hedger = new Hedger();

  spotPrice = 0;
  futuresMarkPrice = 0;
  feedError: string | null = null;

  hedgeMode: 'delta' | 'sentiment' = config.hedgeMode;
  account: FuturesAccount | null = null;
  startEquity: number | null = null;
  equitySeries: { t: number; equity: number; btc: number }[] = [];

  private lastHedge = 0;
  private onTick?: () => void;

  constructor(initialPrice: number) {
    this.spotPrice = initialPrice;
    this.futuresMarkPrice = initialPrice;
    this.sim = new Simulation({ ...defaultConfig, externalPrice: true, btcStart: initialPrice });
  }

  start(onTick: () => void): void {
    this.onTick = onTick;
    setInterval(() => void this.tick(), 1000);
    void this.refreshAccount();
    void this.hedger.refreshPosition();
    setInterval(() => void this.refreshAccount(), 10000);
    setInterval(() => void this.hedger.refreshPosition(), 15000);
  }

  private async refreshAccount(): Promise<void> {
    if (!config.hasKeys()) return;
    try {
      this.account = await getAccount();
      if (this.startEquity == null) this.startEquity = this.account.equity;
    } catch {
      /* keep last snapshot on a hiccup */
    }
  }

  // BTC perp units to hold this tick, given the active mode.
  private hedgeTarget(): number {
    const s = this.sim.getState();
    if (this.hedgeMode === 'sentiment') {
      // directional: lean ∈ [-1,1] → ±(gain × cap). + lean = smart money bullish.
      const lean = s.sentiment?.lean ?? 0;
      return lean * config.sentimentGain * config.maxPositionBtc;
    }
    // delta: neutralise Book C's target
    return s.books.find((b) => b.id === 'C')?.targetUnits ?? 0;
  }

  private async tick(): Promise<void> {
    try {
      const [spot, futures] = await Promise.all([getSpotPrice(), getFuturesMarkPrice()]);
      this.spotPrice = spot;
      this.futuresMarkPrice = futures;
      this.feedError = null;
    } catch (e) {
      this.feedError = String(e);
    }

    this.sim.feedPrice(this.spotPrice);
    this.sim.step();

    const now = Date.now();
    if (now - this.lastHedge >= config.hedgeIntervalSec * 1000) {
      this.lastHedge = now;
      void this.hedger.reconcile(this.hedgeTarget(), this.futuresMarkPrice);
    }

    // equity curve (sampled every ~5s) for observability
    if (this.account && this.sim.tick % 5 === 0) {
      this.equitySeries.push({ t: this.sim.tick, equity: this.account.equity, btc: this.spotPrice });
      if (this.equitySeries.length > 720) this.equitySeries.shift();
    }

    this.onTick?.();
  }

  getState() {
    const s = this.sim.getState();
    const pnlVsStart = this.account && this.startEquity != null ? this.account.equity - this.startEquity : 0;
    return {
      ...s,
      live: {
        spotPrice: this.spotPrice,
        futuresMarkPrice: this.futuresMarkPrice,
        feedError: this.feedError,
        symbol: config.symbol,
        venue: config.futuresBase,
        dryRun: config.dryRun,
        hasKeys: config.hasKeys(),
        hedgeEnabled: this.hedger.enabled,
        hedgeMode: this.hedgeMode,
        livePosition: this.hedger.livePosition,
        maxPositionBtc: config.maxPositionBtc,
        hedgeError: this.hedger.lastError,
        hedgeLog: this.hedger.log.slice(0, 12),
        // real demo futures account
        account: this.account,
        startEquity: this.startEquity,
        accountPnl: pnlVsStart,
        equitySeries: this.equitySeries,
      },
    };
  }

  setHedgeEnabled(on: boolean): void {
    this.hedger.enabled = on;
  }
  setHedgeMode(mode: 'delta' | 'sentiment'): void {
    this.hedgeMode = mode;
  }
}
