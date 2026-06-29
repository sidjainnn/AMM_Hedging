// Simulation orchestrator. Wires the four layers into one deterministic tick
// loop. Everything is reproducible from config.seed (CLAUDE.md Q5): reset()
// rebuilds identical state. Sub-streams are derived per subsystem so adding
// one doesn't perturb the others' draw sequence.

import { RNG } from './rng';
import { SyntheticPrice } from './price';
import { MarketManager } from './market';
import { HedgeEngine } from './hedging';
import { makeAgents, type AgentEngine, type AgentModel } from './agents';
import type { SimConfig, SimState } from './types';

const TENOR_TICKS_8H = 28800; // 1h = 3600 ticks, so 8h = 28800 ticks
const MAX_SERIES = 720;

export class Simulation {
  cfg: SimConfig;
  tick = 0;
  private rng!: RNG;
  private price!: SyntheticPrice;
  private mm!: MarketManager;
  private hedge!: HedgeEngine;
  private agents!: AgentEngine;
  private recentDrift = 0;
  private btcSeries: SimState['btcSeries'] = [];
  private pnlSeries: SimState['pnlSeries'] = [];
  private aggregateDelta = 0;
  private books: SimState['books'] = [];
  private tauStar = 0;

  constructor(cfg: SimConfig) {
    this.cfg = cfg;
    this.reset();
  }

  reset(): void {
    const c = this.cfg;
    this.tick = 0;
    this.rng = new RNG(c.seed);
    this.price = new SyntheticPrice(
      this.rng.derive('price'),
      c.btcStart,
      c.btcVolPerTick,
      c.btcDriftPerTick,
      c.jumpChance,
      c.jumpSize
    );
    if (c.externalPrice) this.price.external = true;
    this.mm = new MarketManager(c.tenors, c.strikePcts, c.engine);
    this.mm.seedAll(0, this.price.spot);
    this.hedge = new HedgeEngine(
      c.hedgeDialB,
      c.kFlat,
      c.feeBps,
      c.fundingRate8h / TENOR_TICKS_8H
    );
    this.agents = makeAgents(c.agentModel, this.rng);
    this.recentDrift = 0;
    this.btcSeries = [{ tick: 0, btc: this.price.spot, provenance: 'sim-ground-truth' }];
    this.pnlSeries = [];
    this.aggregateDelta = 0;
    this.books = [];
    this.tauStar = 0;
  }

  // ---- live config setters (research knobs) ----
  setEngineKind(kind: SimConfig['engine']['kind']): void {
    this.cfg.engine = { ...this.cfg.engine, kind };
    this.mm.setEngine(this.cfg.engine, this.tick, this.price.spot);
  }
  setQuote(patch: Partial<SimConfig['quote']>): void {
    this.cfg.quote = { ...this.cfg.quote, ...patch };
  }
  setAgents(patch: Partial<Pick<SimConfig, 'noiseIntensity' | 'directionalIntensity' | 'arbIntensity'>>): void {
    Object.assign(this.cfg, patch);
  }
  // push the latest live price (external-price mode); consumed next step().
  feedPrice(spot: number): void {
    this.price.feed(spot);
  }

  // a user (you) buys shares against the engine in a specific market.
  // returns the exact cash paid (0 if the market wasn't found).
  userTrade(marketId: string, side: 'YES' | 'NO', shares: number): number {
    const m = this.mm.markets.find((x) => x.id === marketId);
    if (!m || shares <= 0) return 0;
    return m.executeEngineBuy(side, shares, 'you', this.tick);
  }
  setAgentModel(model: AgentModel): void {
    this.cfg.agentModel = model;
    // rebuild from the master seed stream (deterministic); market/hedge state
    // is preserved so you can A/B mid-run.
    this.agents = makeAgents(model, this.rng);
  }
  setHedgeDialB(h: number): void {
    this.cfg.hedgeDialB = h;
    this.hedge.setDialB(h);
  }
  setKFlat(k: number): void {
    this.cfg.kFlat = k;
    this.hedge.setKFlat(k);
  }
  setFeeBps(b: number): void {
    this.cfg.feeBps = b;
    this.hedge.setFeeBps(b);
  }
  setFunding8h(f: number): void {
    this.cfg.fundingRate8h = f;
    this.hedge.setFundingPerTick(f / TENOR_TICKS_8H);
  }

  step(): void {
    this.tick++;
    // 1. synthetic price advances (sim-ground-truth)
    this.price.step();
    const spot = this.price.spot;
    this.recentDrift = 0.9 * this.recentDrift + 0.1 * this.price.lastReturn;

    // 2. roll expired tenors, settle, accumulate realised P&L
    const settled = this.mm.roll(this.tick, spot);
    if (settled.length) {
      this.hedge.onSettled(settled);
      this.agents.onSettled?.(settled, spot); // pay out agent wallets
    }

    // 3. refresh quotes pre-flow
    for (const m of this.mm.markets) m.refreshQuote(this.tick, this.cfg.quote);

    // 4. agents generate flow
    this.agents.step({
      markets: this.mm.markets,
      spot,
      estSigma: this.price.estSigma,
      recentDrift: this.recentDrift,
      tick: this.tick,
      noiseIntensity: this.cfg.noiseIntensity,
      directionalIntensity: this.cfg.directionalIntensity,
      arbIntensity: this.cfg.arbIntensity,
    });

    // 5. refresh quotes post-flow for display
    for (const m of this.mm.markets) m.refreshQuote(this.tick, this.cfg.quote);

    // 6. hedge tick
    const h = this.hedge.tick(
      this.mm.markets,
      spot,
      this.cfg.btcVolPerTick,
      this.price.estSigma,
      this.tick
    );
    this.aggregateDelta = h.aggregateDelta;
    this.books = h.books;
    this.tauStar = h.tauStar;

    // 7. series
    this.btcSeries.push({ tick: this.tick, btc: spot, provenance: 'sim-ground-truth' });
    if (this.btcSeries.length > MAX_SERIES) this.btcSeries.shift();
    const a = this.books.find((b) => b.id === 'A');
    this.pnlSeries.push({
      tick: this.tick,
      btc: spot,
      A: this.books.find((b) => b.id === 'A')?.netPnl ?? 0,
      B: this.books.find((b) => b.id === 'B')?.netPnl ?? 0,
      C: this.books.find((b) => b.id === 'C')?.netPnl ?? 0,
      spreadCapture: a?.spreadCapture ?? 0,
      inventoryPnl: a?.inventoryPnl ?? 0,
      hedgePnl: a?.hedgePnl ?? 0,
      funding: a?.fundingAccrued ?? 0,
    });
    if (this.pnlSeries.length > MAX_SERIES) this.pnlSeries.shift();
  }

  getState(): SimState {
    return {
      tick: this.tick,
      btc: this.price.spot,
      btcSeries: this.btcSeries,
      estSigma: this.price.estSigma,
      markets: this.mm.markets.map((m) => m.snapshot(this.tick)),
      books: this.books,
      aggregateDelta: this.aggregateDelta,
      pnlSeries: this.pnlSeries,
      hedgeLog: this.hedge.log,
      tauStar: this.tauStar,
      agentStats: this.agents.stats?.(this.mm.markets),
      sentiment: this.agents.sentiment?.(),
    };
  }

  // Static stress test (CLAUDE.md Q5/Q5-stress): instantaneous spot shock,
  // reprice live markets + hedge marks, report per-book P&L delta. Pure
  // function of current state — does not advance or branch the sim.
  stress(shocks: number[]): { shockPct: number; A: number; B: number; C: number }[] {
    const base = this.books;
    const spot = this.price.spot;
    return shocks.map((pct) => {
      const s = spot * (1 + pct);
      const res: { shockPct: number; A: number; B: number; C: number } = {
        shockPct: pct,
        A: 0,
        B: 0,
        C: 0,
      };
      // hedge legs reprice linearly with spot; book net = base + units*(s-spot)
      for (const bk of base) {
        const pnlMove = bk.positionUnits * (s - spot);
        (res as Record<string, number>)[bk.id] = pnlMove;
      }
      return res;
    });
  }
}
