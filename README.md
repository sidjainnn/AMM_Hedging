# Crypto Binary Prediction Market — Research Simulator

A client-side TypeScript + React simulation of crypto binary prediction markets.
It compares three feed-free pricing engines (LMSR / CPMM / LS-LMSR) under a
Stoikov / manual-spread quoting overlay, runs simulated agents that create
realistic order flow and skew, and tests a real-time hedging layer (three
parallel books) against a synthetic BTC price. Crypto-only, no real money, no
real venues — everything runs in-memory in the browser.

Design specs live in the parent repo's `docs/` and `CLAUDE.md`. This package is
the implementation.

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # typecheck + production bundle
```

Requires Node 18+ (developed on Node 22).

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
  price.ts               synthetic BTC GBM + EWMA est-σ
  agents/                swappable trader models (see below)
    index.ts             AgentEngine interface + factory
    simple.ts            original v1 (noise · directional · arbitrageur)
    behavioral.ts        heterogeneous population (default)
  hedging.ts             aggregate δ, σ√τ flatten, books A/B/C, P&L decomposition
  sim.ts                 tick-loop orchestrator + static stress test
  config.ts              default scenario / tunables
src/ui/                  React dashboard
  useSimulation.ts       drives the tick loop, exposes snapshots
  Page1Trading.tsx       engine/quoting/agent controls, BTC chart, markets, book
  Page2Hedge.tsx         book cards, P&L chart, per-tenor, stress, knobs, log
```

## Golden rules enforced

1. **Feed-free pricing** — engine price is a function of inventory `q` only; the
   synthetic BTC price is never a pricing input.
2. **Only engine trades move price** — order placement alone does not.
3. **User↔user trades are price-neutral** — pair-minting; only user↔engine flow
   (incl. arbitrage) moves `q`.
4. **No real money / venues** — hedges are in-memory notionals marked against the
   synthetic price with modelled fees + funding.
5. **Quoting never mutates `q`** — Stoikov/spread change displayed quotes only.
6. **Sim vs deployment honesty** — the true GBM σ is hidden ground truth; agents
   and Book C use only an EWMA-estimated σ (deployment-available). Inputs are
   tagged `sim-ground-truth` vs `deployment-available` in the UI.

## The three hedge books

- **A — pure δ hedge (true σ):** full neutralisation, ground-truth delta.
- **B — ride bias (true σ, dial h):** carries part of the crowd signal (h<1).
- **C — pure δ hedge (approx σ):** deployment-realistic, uses estimated σ.

A vs B isolates *policy*; A vs C isolates *deployment realism* (vol
mis-estimation). All three share one market-making book and differ only in the
hedge leg, so the P&L decomposition (spread capture · inventory · hedge · fees ·
funding) is directly comparable.

## Agent models (swappable, feed-free)

Toggle on the Trading page; both reference only the synthetic spot + estimated σ
(no external data feed).

- **`behavioral`** (default) — a persistent population of ~95 heterogeneous
  traders calibrated to documented prediction-market / retail stylized facts:
  bursty (volatility-driven) arrivals, heavy-tailed (lognormal) order sizes,
  patience (limit vs market), and archetypes noise / momentum / contrarian /
  informed with a favorite-longshot bias. Produces dispersed, realistic prices.
- **`simple`** — the original v1 agents (noise / directional / arbitrageur),
  preserved verbatim for rollback and A/B comparison.

Both are deterministic and net-profitable across seeds (8/8 in testing). A hard
rollback point is also tagged in git (the initial snapshot commit).

## Determinism

The entire run is reproducible from `config.seed`. Reset re-derives identical
state; change the seed in the top bar to A/B different paths.
