# Crypto Binary Prediction Market — Research Simulator

A **research dashboard + simulation** for crypto binary prediction markets. It compares
pricing engines (LMSR / CPMM / LS-LMSR) under a Stoikov/manual-spread quoting layer, runs
simulated agents that create realistic order flow and skew, and tests a **real-time hedging
layer** against the **live Binance (demo) BTC feed**. Crypto-only. No real money — it runs
against the Binance **demo** venue (paper). The BTC underlying is the live Binance price;
the binary markets and the hedge book are simulated/paper.

This file is loaded every session: keep it lean. Detailed specs live in `docs/` and should be
read on demand (see pointers below).

> **Resuming work? Read `docs/STATUS.md` first** — current state, how to run, and the
> prioritized next steps. `docs/agents-implementation.md` holds the deferred agent-reward design.

## Stack
- **TypeScript** end to end (shared types from engine → UI).
- **React** frontend (live-updating dashboard + charts).
- **Client-side sim** to start — the whole simulation runs in the browser, no backend/API.
  Extract a server later only if real data/MCP is ever added.

## Golden rules (never violate)
1. **Feed from Binance for the underlying; inventory-priced binaries.** The BTC underlying
   price is the **live Binance feed** — the single source of truth for marking P&L, settling
   markets, and informing agents (synthetic GBM is off). The binary **pricing engine still
   prices off inventory `q` only** (flow-based discovery); it does NOT anchor quotes to the
   feed. (If you ever want the engine itself anchored to Binance, that replaces the AMM
   mechanism — a separate, deliberate change.)
2. **Only trades vs the engine move price.** Order placement alone does not. `q` is the price state.
3. **User↔user trades are price-neutral** (pair-minting). Only user↔engine flow (incl. arbitrage)
   moves price. Price discovery comes from flow + arbitrage, not from the house anchoring.
4. **No real money; demo venue only.** Hedging runs against the Binance **demo** futures venue
   (paper). Production hosts are hard-blocked in the server; secrets live only in `server/.env`.
5. **Quoting overlay never mutates `q`.** Stoikov/spread change displayed quotes only.
6. **Sim vs deployment honesty.** Tag every input as `sim-ground-truth` (synthetic price → true
   delta/mark) or `deployment-available` (σ/τ/own-flow only). Never let a "deployable" mechanism
   secretly read the synthetic price.

## Build order
1. **Engine core** — LMSR/CPMM/LS-LMSR + inventory + the rolling-tenor market loop. → `docs/engines.md`, `docs/markets.md`
2. **Agents + synthetic price** — noise / directional / arbitrageur agents + visible BTC random walk. → `docs/agents.md`
3. **Hedging** — numerical settlement-value delta + the three parallel hedge books. → `docs/hedging.md`
4. **Pages** — market/trading dashboard + hedge overview page. → `docs/dashboard.md`

Build each layer testable before the next sits on it.

## Where things are documented
- `docs/engines.md` — pricing engines (LMSR/CPMM/LS-LMSR), inventory, formulas.
- `docs/markets.md` — rolling staggered tenors, order book, matching, pair-minting.
- `docs/quoting.md` — Stoikov + manual-spread overlay.
- `docs/agents.md` — agent set + synthetic BTC price process.
- `docs/hedging.md` — settlement-value delta, T*(σ) flatten trigger, three hedge books, fees/funding.
- `docs/dashboard.md` — the two pages and what each shows.
- `docs/decisions.md` — *why* the locked decisions were made + parked/open items. Read when a
  design choice is being questioned or extended.

## Scope discipline
This is a research simulator, not production. The IAMM behavioral-intelligence layer was
**dropped** as too complex for v1. Resist adding knobs: the value is *seeing the mechanics
clearly*, not tuning everything. Show the mechanics, don't bury them.
