# Crypto Binary Prediction Market — Research Simulator

A TypeScript + React simulation of crypto binary prediction markets. It compares
three **inventory-priced AMM** engines (LMSR / CPMM / LS-LMSR) under a Stoikov /
manual-spread quoting overlay, runs simulated agents that create realistic order
flow and skew, and tests a real-time perp hedging layer — wired to the
**live Binance demo** venue. The **live Binance feed is the single source of
truth** for the BTC underlying (marking, settlement, agents); the AMM engine
still discovers the *binary* price from inventory/flow, not from the feed. The BTC underlying is the live Binance price; the
binary markets + hedge book are simulated/paper. No real money (demo only).

A small **Node/Express backend** (`server/`) runs the sim off the live feed and
places real **demo** futures orders; the React app is the dashboard.

**Resuming work?** Read [`docs/STATUS.md`](docs/STATUS.md) — current state, how to
run, and prioritized next steps. Original design specs live in `docs/` + `CLAUDE.md`.

## Run

```bash
# web dashboard
npm install
npm run dev      # http://localhost:5173 (or 5174)
npm run build    # typecheck + production bundle

# live backend (for the Live demo tab + live price feed)
cd server
cp .env.example .env     # add your Binance DEMO key + secret (both)
npm install
npm start                # http://localhost:8787
```

Requires Node 18+ (developed on Node 22). Keys live only in `server/.env`
(gitignored). The backend is demo/paper only — production hosts are hard-blocked,
`DRY_RUN=true` by default, and hedging must be enabled on the Live tab.

## Architecture

Built bottom-up in the doc's four-layer order; each layer is testable before
the next sits on it.

```
src/sim/                 deterministic simulation core (no React)
  rng.ts                 seedable RNG (mulberry32) + named sub-streams
  math.ts                log-sum-exp / softplus / normal CDF (float64, stable)
  events.ts              digital event prob P(BTC(t+τ)>K) + dp/dS
  engines/index.ts       LMSR · CPMM · LS-LMSR behind one interface
  quoting.ts             manual spread + Avellaneda–Stoikov overlay
  market.ts              one binary market + MarketManager (rolling tenors,
                         strike ladder, order book, pair-mint / engine channels)
  price.ts               synthetic GBM OR external live price (externalPrice flag)
  agents/                swappable trader models (see below)
    index.ts             AgentEngine interface + factory
    simple.ts            original v1 (noise · directional · arbitrageur) — rollback
    behavioral.ts        default: Poisson arrivals, wallets/reward, sentiment
  hedging.ts             aggregate δ, σ√τ flatten, books A/B/C, P&L decomposition
  sim.ts                 tick-loop orchestrator, userTrade, stress, agentStats
  backtest.ts/validate.ts  headless tools (force synthetic price)
  config.ts              default scenario / tunables
src/ui/                  React dashboard (5 tabs)
  Page5Market.tsx        5m Polymarket-style market + user wallet + controls
  Page1Trading.tsx       engine/quoting/agent controls, BTC chart, markets, book
  Page2Hedge.tsx         book cards, P&L chart, per-tenor, stress, knobs, log
  Page3Backtest.tsx      3-engine P&L comparison (Stoikov vs fixed spread)
  Page4Live.tsx          live demo: account equity, sentiment, hedge-mode toggle
  useSimulation.ts / useLivePrice.ts / useLiveBackend.ts
server/                  Node/Express backend: live Binance demo feed + sim +
                         signed demo perp orders (binance/config/hedger/runner)
```

## Golden rules enforced

1. **Inventory-priced AMM** — the binary engine price is a function of inventory
   `q` only; the **live Binance feed is the source of truth** for the BTC
   underlying (marking/settlement/agents) but is never a *quote* input.
2. **Only engine trades move price** — order placement alone does not.
3. **User↔user trades are price-neutral** — pair-minting; only user↔engine flow
   (incl. arbitrage) moves `q`.
4. **No real money; demo venue only** — the live backend places real **demo**
   perp orders (mainnet hard-blocked, `DRY_RUN` default); browser-sim hedge
   books remain in-memory notionals with modelled fees + funding.
5. **Quoting never mutates `q`** — Stoikov/spread change displayed quotes only.
6. **Sim vs deployment honesty** — in sim the true GBM σ is hidden ground truth;
   live, est-σ is realised from real returns. Only **Book C** (est-σ) is
   deployable — A/B use a σ you don't have live. Inputs tagged
   `sim-ground-truth` vs `deployment-available`.

## The three hedge books

- **A — pure δ hedge (true σ):** full neutralisation, ground-truth delta.
- **B — ride bias (true σ, dial h):** carries part of the crowd signal (h<1).
- **C — pure δ hedge (approx σ):** deployment-realistic, uses estimated σ.

A vs B isolates *policy*; A vs C isolates *deployment realism* (vol
mis-estimation). All three share one market-making book and differ only in the
hedge leg, so the P&L decomposition (spread capture · inventory · hedge · fees ·
funding) is directly comparable.

## Agent models (swappable)

Toggle on the Trading / 5m pages; both reference the spot (live or synthetic) +
estimated σ — no external data beyond the price feed.

- **`behavioral`** (default) — a persistent ~95-trader population: **sporadic
  Poisson arrivals** (most ticks have no trade), heavy-tailed sizes, patience
  (limit vs market), archetypes noise / momentum / contrarian / informed with a
  favorite-longshot bias, **finite wallets as a reward function** (broke→drop
  out, winners→bigger), and a **skill-weighted sentiment** signal.
- **`simple`** — the original v1 agents (noise / directional / arbitrageur),
  preserved verbatim for rollback and A/B comparison.

## Wallets & sentiment

- **User wallet** (5m page): finite cash, position, equity, P&L.
- **Agent wallets**: per-roll settlement P&L; broke agents drop out, winners
  trade bigger — the reward signal, shown in the agent-population panel.
- **Information sentiment**: skill(wealth)-weighted net agent positioning →
  smart-money `pSent`/lean, which can drive a **sentiment hedge mode** (perp ∝
  lean) on the Live tab. See `docs/agents-implementation.md` for the deferred
  advanced reward + precision-weighted estimator.

## Determinism

The pure sim is reproducible from `config.seed`. **Live mode is not** — it's
driven by the real Binance feed. Headless backtest/validate force the synthetic
price for reproducibility.
