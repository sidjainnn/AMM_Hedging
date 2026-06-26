import { Simulation } from '../../src/sim/sim';
import { defaultConfig } from '../../src/sim/config';
import { getSpotPrice, getFuturesMarkPrice } from './binance';
import { Hedger } from './hedger';
import { config } from './config';

export class Runner {
  private sim: Simulation;
  hedger = new Hedger();

  // market state
  spotPrice = 0;
  futuresMarkPrice = 0;

  feedError: string | null = null;

  private lastHedge = 0;
  private onTick?: () => void;

  constructor(initialPrice: number) {
    this.spotPrice = initialPrice;
    this.futuresMarkPrice = initialPrice;

    this.sim = new Simulation({
      ...defaultConfig,
      externalPrice: true,
      btcStart: initialPrice,
    });
  }

  start(onTick: () => void): void {
    this.onTick = onTick;
    setInterval(() => void this.tick(), 1000);
    // keep the displayed demo position fresh even when not actively hedging
    void this.hedger.refreshPosition();
    setInterval(() => void this.hedger.refreshPosition(), 15000);
  }

  private async tick(): Promise<void> {
    try {
      // fetch both feeds in parallel (important for freshness)
      const [spot, futures] = await Promise.all([
        getSpotPrice(),
        getFuturesMarkPrice(),
      ]);

      this.spotPrice = spot;
      this.futuresMarkPrice = futures;

      this.feedError = null;
    } catch (e) {
      this.feedError = String(e);
    }

    // ==================================================
    // CORE SIMULATION (use SPOT as truth for PnL)
    // ==================================================
    this.sim.feedPrice(this.spotPrice);
    this.sim.step();

    // ==================================================
    // HEDGING (use FUTURES for execution realism)
    // ==================================================
    const now = Date.now();

    if (now - this.lastHedge >= config.hedgeIntervalSec * 1000) {
      this.lastHedge = now;

      const c = this.sim.getState().books.find((b) => b.id === 'C');
      if (c) {
        void this.hedger.reconcile(c.targetUnits, this.futuresMarkPrice);
      }
    }

    this.onTick?.();
  }

  getState() {
    const s = this.sim.getState();

    return {
      ...s,
      live: {
        // ✅ UI price (THIS should match Binance spot page)
        spotPrice: this.spotPrice,

        // 🔵 hedging / risk engine price
        futuresMarkPrice: this.futuresMarkPrice,

        feedError: this.feedError,

        symbol: config.symbol,
        venue: config.futuresBase,

        dryRun: config.dryRun,
        hasKeys: config.hasKeys(),

        hedgeEnabled: this.hedger.enabled,
        livePosition: this.hedger.livePosition,
        maxPositionBtc: config.maxPositionBtc,

        hedgeError: this.hedger.lastError,
        hedgeLog: this.hedger.log.slice(0, 12),
      },
    };
  }

  setHedgeEnabled(on: boolean): void {
    this.hedger.enabled = on;
  }
}