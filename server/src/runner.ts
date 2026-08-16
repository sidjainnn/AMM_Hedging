import { Simulation } from '../../src/sim/sim';
import { defaultConfig } from '../../src/sim/config';
import { getSpotPrice, getFuturesMarkPrice, getAccount, setLeverage, setMultiAssetsMargin, type FuturesAccount } from './binance';
import { Hedger } from './hedger';
import { WindowLedger, type WindowBaseline } from './ledger';
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
  private lastFeedOk = Date.now();
  feedStale = false; // true → market time frozen (no steps, no settlements)

  hedgeMode: 'delta' | 'sentiment' | 'combined' = config.hedgeMode;
  account: FuturesAccount | null = null;
  startEquity: number | null = null;
  equitySeries: { t: number; equity: number; btc: number }[] = [];

  private lastHedge = 0;
  private onTick?: () => void;

  // volatility gate: only hedge when realized vol breaches the threshold
  private returns: number[] = [];
  private prevSpot = 0;
  realizedVol = 0;
  volGateOn = false; // vol-gate state (with hysteresis)
  // inventory gate + combined reason, published from the sim each tick
  notionalUsdt = 0;
  invGateOn = false;
  liveIdleReason: 'armed' | 'idle-vol' | 'idle-inv' | 'disabled' | 'untracked' = 'untracked';
  // Adaptive inventory gate: a fixed $ threshold can't discriminate against a
  // moving exposure distribution (notional = δ×spot scales with BTC level and
  // flow), so in 'adaptive' mode the gate = max(floor, Pctl of the last hour's
  // notional samples). "Hedge only the riskiest X% of periods" then stays true
  // in any regime without retuning.
  gateMode: 'adaptive' | 'fixed' = config.hedgeGateMode;
  gatePctl = config.hedgeGatePctl;
  private notionalHist: number[] = [];
  effectiveGate = config.hedgeNotionalUsdt;

  // A/B window ledger: one CSV row per settled 5m window of THIS book
  ledger = new WindowLedger();
  private ledgerMktId: string | null = null;
  lastWindowRow: import('./ledger').LedgerRow | null = null;

  // A/B scheduler: toggles the hedge at window boundaries — abBlocksOn hedged
  // windows then abBlocksOff unhedged (validation) windows, repeating. The
  // ON→OFF flatten fires one tick BEFORE the roll so its fees/slippage land in
  // the last hedged window, not contaminating the first unhedged one.
  abRunning = false;
  private abPos = 0; // window index within the on+off cycle

  constructor(initialPrice: number) {
    this.spotPrice = initialPrice;
    this.futuresMarkPrice = initialPrice;
    this.sim = new Simulation({ ...defaultConfig, externalPrice: true, btcStart: initialPrice });
    // Apply the live (env) gate overrides to the sim so the demo hedge uses the
    // same risk-tier the runner gates on, and ops can recalibrate without a
    // recompile (sim flow is simulated → synthetic $200 may not match live).
    this.sim.setHedgeNotionalUsdt(config.hedgeNotionalUsdt);
    this.sim.setRiskTier(config.riskTierLow, config.riskTierHigh);
  }

  leverage = config.leverage;

  start(onTick: () => void): void {
    this.onTick = onTick;
    void this.applyAccountConfig(); // multi-assets margin + leverage
    void this.reconcileStartup(); // flatten any inherited (orphaned) position
    setInterval(() => void this.tick(), 1000);
    void this.refreshAccount();
    setInterval(() => void this.refreshAccount(), 10000);
    setInterval(() => void this.hedger.refreshPosition(), 15000);
  }

  // A restart inherits whatever position is open on the venue, but hedging boots
  // disabled — so an orphaned position would sit unmanaged (this happened in
  // testing: −0.0336 BTC left over across restarts). If we boot disabled with a
  // non-trivial position, flatten it so the account starts clean.
  private async reconcileStartup(): Promise<void> {
    if (!config.hasKeys()) return;
    await this.hedger.refreshPosition();
    const pos = this.hedger.livePosition;
    if (!this.hedger.enabled && Math.abs(pos) > 1e-4) {
      console.warn(`[amm-server] inherited position ${pos} BTC with hedging disabled — flattening`);
      await this.hedger.flatten(this.futuresMarkPrice || this.spotPrice);
    }
  }

  // One-time account setup: enable multi-assets margin (USDC+USDT back the
  // hedge) and set leverage. Both fail loudly-but-safely (e.g. can't change with
  // an open position) — we log and carry on rather than crash the server.
  private async applyAccountConfig(): Promise<void> {
    if (!config.hasKeys()) return;
    try {
      await setMultiAssetsMargin(config.multiAssets);
      console.log(`[amm-server] multi-assets margin = ${config.multiAssets}`);
    } catch (e) {
      console.warn('[amm-server] multi-assets margin not set:', String(e).slice(0, 120));
    }
    try {
      await setLeverage(this.leverage);
      console.log(`[amm-server] leverage = ${this.leverage}x`);
    } catch (e) {
      console.warn('[amm-server] leverage not set:', String(e).slice(0, 120));
    }
  }

  async setLeverage(x: number): Promise<{ leverage: number; error: string | null }> {
    const lev = Math.max(1, Math.min(125, Math.round(x)));
    try {
      await setLeverage(lev);
      this.leverage = lev;
      return { leverage: lev, error: null };
    } catch (e) {
      return { leverage: this.leverage, error: String(e).slice(0, 160) };
    }
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

  // Rolling realized vol (stdev of per-tick simple returns) + the on/off gate
  // with hysteresis, so the hedge only runs in regimes where it out-earns fees.
  private updateVol(): void {
    const s = this.spotPrice;
    if (this.prevSpot > 0 && s > 0) {
      this.returns.push(s / this.prevSpot - 1);
      if (this.returns.length > config.hedgeVolWindow) this.returns.shift();
    }
    this.prevSpot = s;
    const n = this.returns.length;
    if (n >= 5) {
      const mean = this.returns.reduce((a, b) => a + b, 0) / n;
      const variance = this.returns.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
      this.realizedVol = Math.sqrt(variance);
    }
    if (!config.hedgeVolGate) {
      this.volGateOn = true;
      return;
    }
    const on = config.hedgeVolThreshold;
    const off = on * config.hedgeVolHysteresis;
    if (!this.volGateOn && this.realizedVol >= on) this.volGateOn = true;
    else if (this.volGateOn && this.realizedVol < off) this.volGateOn = false;
  }

  // Inventory gate with self-calibration + hysteresis. Adaptive: gate =
  // max(floor, percentile of the last hour of notional samples); warmup (<5min
  // of samples) falls back to the floor. Hysteresis: open at ≥ gate, close
  // below 0.6×gate (same style as the vol gate — no flapping at the boundary).
  // The effective gate is also pushed into the sim so the risk-tier staircase
  // (0/0.3/0.7/1.0 at gate/4×/16×) scales with the regime.
  private updateInvGate(): void {
    this.notionalHist.push(this.notionalUsdt);
    if (this.notionalHist.length > 3600) this.notionalHist.shift();
    const floor = config.hedgeNotionalUsdt;
    if (this.gateMode === 'adaptive' && this.notionalHist.length >= 300) {
      const sorted = [...this.notionalHist].sort((a, b) => a - b);
      const p = sorted[Math.min(sorted.length - 1, Math.floor(this.gatePctl * sorted.length))];
      this.effectiveGate = Math.max(floor, p);
    } else {
      this.effectiveGate = floor;
    }
    this.sim.setHedgeNotionalUsdt(this.effectiveGate);
    if (!this.invGateOn && this.notionalUsdt >= this.effectiveGate) this.invGateOn = true;
    else if (this.invGateOn && this.notionalUsdt < this.effectiveGate * 0.6) this.invGateOn = false;
  }

  // BTC perp units to hold this tick, given the active mode.
  private hedgeTarget(): number {
    const s = this.sim.getState();
    const delta = s.books.find((b) => b.id === 'C')?.targetUnits ?? 0; // skew-neutralising δ
    const lean = s.sentiment?.lean ?? 0;
    const cap = config.maxNotionalUsdt / (this.futuresMarkPrice || 1); // full-budget cap
    if (this.hedgeMode === 'sentiment') {
      return lean * config.sentimentGain * cap; // directional smart-money bet
    }
    if (this.hedgeMode === 'combined') {
      return delta + 0.5 * cap * lean * config.sentimentGain; // hedge skew + tilt
    }
    return delta; // delta: neutralise the liquidity skew
  }

  private async tick(): Promise<void> {
    try {
      const [spot, futures] = await Promise.all([getSpotPrice(), getFuturesMarkPrice()]);
      this.spotPrice = spot;
      this.futuresMarkPrice = futures;
      this.feedError = null;
      this.lastFeedOk = Date.now();
    } catch (e) {
      this.feedError = String(e);
    }

    // Stale-feed guard: if Binance has been unreachable too long, FREEZE market
    // time — no steps, so nothing can settle on a frozen price. Resumes (and
    // settles any overdue markets on the fresh price) when the feed recovers.
    this.feedStale = Date.now() - this.lastFeedOk > config.feedStaleSec * 1000;
    if (this.feedStale) {
      this.onTick?.(); // still broadcast state so the UI can show "feed stale"
      return;
    }

    this.sim.feedPrice(this.spotPrice);
    this.sim.step();

    this.updateVol();

    // Merged gate: fire only when BOTH the vol gate AND the inventory gate are
    // open. The inventory gate self-calibrates in 'adaptive' mode (percentile
    // of the last hour's exposure, floored) so it keeps discriminating as the
    // flow regime / BTC level drift; 'fixed' mode uses the absolute threshold.
    const st = this.sim.getState();
    this.notionalUsdt = st.notionalUsdt;
    this.updateInvGate();
    const active = this.volGateOn && this.invGateOn;
    this.liveIdleReason = !this.hedger.enabled
      ? 'disabled'
      : !this.volGateOn
        ? 'idle-vol'
        : !this.invGateOn
          ? 'idle-inv'
          : 'armed';

    const now = Date.now();
    if (now - this.lastHedge >= config.hedgeIntervalSec * 1000) {
      this.lastHedge = now;
      // hold the hedge target only while armed; otherwise flatten to 0 so calm /
      // low-inventory regimes don't bleed round-trip fees. (The combined-mode
      // sentiment tilt rides inside hedgeTarget(), so it too only fires armed.)
      const target = active ? this.hedgeTarget() : 0;
      void this.hedger.reconcile(target, this.futuresMarkPrice);
    }

    // ---- A/B window ledger: accumulate this tick; close/open on the 5m roll
    this.ledger.tick({
      enabled: this.hedger.enabled,
      idleReason: this.liveIdleReason,
      stale: this.feedStale,
      realizedVol: this.realizedVol,
    });
    const mkt5 = st.markets.find((m) => m.tenorLabel === '5m');
    // A/B scheduler: pre-roll flatten when the NEXT window is an OFF block, so
    // the closing trade is attributed to the hedged arm.
    if (this.abRunning && mkt5 && mkt5.tauTicks <= 1) {
      const cycle = config.abBlocksOn + config.abBlocksOff;
      const nextOn = (this.abPos + 1) % cycle < config.abBlocksOn;
      if (!nextOn && this.hedger.enabled) {
        this.hedger.enabled = false;
        void this.hedger.flatten(this.futuresMarkPrice);
      }
    }
    if (mkt5 && mkt5.id !== this.ledgerMktId) {
      // A/B scheduler: advance the block position at each roll
      if (this.abRunning && this.ledgerMktId != null) {
        const cycle = config.abBlocksOn + config.abBlocksOff;
        this.abPos = (this.abPos + 1) % cycle;
        this.hedger.enabled = this.abPos < config.abBlocksOn;
      }
      const c = st.books.find((b) => b.id === 'C');
      const snap = {
        btc: this.spotPrice,
        spread: c?.spreadCapture ?? 0,
        inv: c?.inventoryPnl ?? 0,
        equity: this.account?.equity ?? null,
        hedgePnlCum: this.hedger.hedgePnl(this.futuresMarkPrice), // hedger-tracked, exact at boundary
        fees: this.hedger.feesPaid,
        slippage: this.hedger.slippagePaid,
        fills: this.hedger.fillCount,
        notionalTraded: this.hedger.notionalTraded,
      };
      if (this.ledgerMktId != null) {
        this.lastWindowRow = this.ledger.close({
          ...snap,
          gateMode: this.gateMode,
          effectiveGate: this.effectiveGate,
        });
      }
      // the just-opened window is a "transition" window when it's the FIRST
      // unhedged window after a hedged block (flatten P&L bleeds across here).
      const isTransition = this.abRunning && this.abPos === config.abBlocksOn;
      this.ledger.open({ ...snap, strike: mkt5.strike } as WindowBaseline, isTransition);
      this.ledgerMktId = mkt5.id;
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
        feedStale: this.feedStale,
        symbol: config.symbol,
        venue: config.futuresBase,
        dryRun: config.dryRun,
        hasKeys: config.hasKeys(),
        hedgeEnabled: this.hedger.enabled,
        hedgeMode: this.hedgeMode,
        livePosition: this.hedger.livePosition,
        maxPositionBtc: config.maxPositionBtc,
        maxNotionalUsdt: config.maxNotionalUsdt,
        realizedVol: this.realizedVol,
        volThreshold: config.hedgeVolThreshold,
        volGate: config.hedgeVolGate,
        notionalUsdt: this.notionalUsdt,
        notionalGate: this.effectiveGate,
        gateMode: this.gateMode,
        gatePctl: this.gatePctl,
        idleReason: this.liveIdleReason,
        hedgeActive: this.liveIdleReason === 'armed',
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

  // lightweight status for the 5m-page hedge button (no full sim snapshot)
  hedgeStatus() {
    return {
      hedgeEnabled: this.hedger.enabled,
      dryRun: config.dryRun,
      hasKeys: config.hasKeys(),
      hedgeMode: this.hedgeMode,
      livePosition: this.hedger.livePosition,
      equity: this.account?.equity ?? null,
      mark: this.futuresMarkPrice,
      symbol: config.symbol,
      hedgeError: this.hedger.lastError,
      realizedVol: this.realizedVol,
      volThreshold: config.hedgeVolThreshold,
      volGate: config.hedgeVolGate,
      notionalUsdt: this.notionalUsdt,
      notionalGate: this.effectiveGate,
      gateMode: this.gateMode,
      gatePctl: this.gatePctl,
      idleReason: this.liveIdleReason,
      hedgeActive: this.liveIdleReason === 'armed',
      feesPaid: this.hedger.feesPaid,
      leverage: this.leverage,
      abRunning: this.abRunning,
      abPos: this.abPos,
      abBlocksOn: config.abBlocksOn,
      abBlocksOff: config.abBlocksOff,
    };
  }

  setHedgeEnabled(on: boolean): void {
    this.abRunning = false; // manual toggle always wins — stops the A/B schedule
    this.hedger.enabled = on;
    // turning OFF flattens any open perp position so the kill switch leaves no
    // residual directional exposure (was previously left open & unmanaged).
    if (!on) void this.hedger.flatten(this.futuresMarkPrice);
  }

  // A/B run control. Start = hedge ON now (first block is hedged), then the
  // scheduler alternates at window boundaries. Stop = schedule off + flatten.
  setABRunning(on: boolean): void {
    this.abRunning = on;
    this.abPos = 0;
    this.hedger.enabled = on ? true : false;
    if (!on) void this.hedger.flatten(this.futuresMarkPrice);
  }
  setHedgeMode(mode: 'delta' | 'sentiment' | 'combined'): void {
    this.hedgeMode = mode;
  }

  // Runtime gate calibration (no restart). Setting an explicit notional
  // switches to 'fixed' mode (the manual override wins); mode:'adaptive'
  // returns to the self-calibrating percentile gate.
  setGates(patch: { notionalUsdt?: number; volThreshold?: number; mode?: 'adaptive' | 'fixed'; pctl?: number }): void {
    if (patch.notionalUsdt != null && isFinite(patch.notionalUsdt) && patch.notionalUsdt >= 0) {
      config.hedgeNotionalUsdt = patch.notionalUsdt;
      this.gateMode = 'fixed';
      this.effectiveGate = patch.notionalUsdt; // reflect immediately (not next tick)
    }
    if (patch.mode === 'adaptive' || patch.mode === 'fixed') this.gateMode = patch.mode;
    if (patch.pctl != null && isFinite(patch.pctl) && patch.pctl > 0 && patch.pctl < 1) this.gatePctl = patch.pctl;
    if (patch.volThreshold != null && isFinite(patch.volThreshold) && patch.volThreshold >= 0) {
      config.hedgeVolThreshold = patch.volThreshold;
    }
  }
}
