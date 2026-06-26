import { Simulation } from '../../src/sim/sim';
import { defaultConfig } from '../../src/sim/config';
import { getMarkPrice } from './binance';
import { Hedger } from './hedger';
import { config } from './config';

// Runs the sim core server-side in real time, driven by the live Binance feed,
// and reconciles the demo hedge each interval. Pricing stays feed-free: the
// engine prices off inventory q; the live price only marks P&L / settles /
// informs agents (golden rule #1 preserved; #4 now = demo venue).

export class Runner {
  private sim: Simulation;
  hedger = new Hedger();
  markPrice = 0;
  feedError: string | null = null;
  private lastHedge = 0;
  private onTick?: () => void;

  constructor(initialPrice: number) {
    this.markPrice = initialPrice;
    this.sim = new Simulation({
      ...defaultConfig,
      externalPrice: true,
      btcStart: initialPrice,
    });
  }

  start(onTick: () => void): void {
    this.onTick = onTick;
    // 1 tick = 1 market-second: poll price + step once per real second.
    setInterval(() => void this.tick(), 1000);
    // refresh live position periodically even when idle
    setInterval(() => void this.hedger.refreshPosition(), 15000);
  }

  private async tick(): Promise<void> {
    try {
      this.markPrice = await getMarkPrice();
      this.feedError = null;
    } catch (e) {
      this.feedError = String(e); // hold last price on a feed hiccup
    }
    this.sim.feedPrice(this.markPrice);
    this.sim.step();

    // reconcile the hedge to Book C's target, at most every HEDGE_INTERVAL_SEC
    const now = Date.now();
    if (now - this.lastHedge >= config.hedgeIntervalSec * 1000) {
      this.lastHedge = now;
      const c = this.sim.getState().books.find((b) => b.id === 'C');
      if (c) void this.hedger.reconcile(c.targetUnits, this.markPrice);
    }
    this.onTick?.();
  }

  getState() {
    const s = this.sim.getState();
    return {
      ...s,
      live: {
        markPrice: this.markPrice,
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
