# STATUS / HANDOFF — read this first in a new session

Last updated: build session that added the 5m-page P&L/money-flow panel, Hedge
Risk Lab, the Binance hedge on/off button, the break-even harness (k=12 default),
and MM/agent P&L reconciliation — on top of live Binance demo hedging + wallets +
information sentiment.

**To resume cold:** open Claude Code in `~/Desktop` (loads memory + CLAUDE.md),
then say "read docs/STATUS.md and docs/agents-implementation.md".

---

## What this project is
A research simulator for crypto **binary prediction markets**: inventory-priced
AMM engines (LMSR / CPMM / LS-LMSR) + a quoting overlay + simulated agents + a
real-time **perp hedging** layer, wired to the **live Binance demo** venue. The
**live Binance feed is the single source of truth** for the BTC underlying;
synthetic-feed testing is retired (GBM survives only as a backtest fixture).
Central thesis under test: *can hedging the AMM's inventory skew on perps
(informed by prediction-market sentiment) neutralize the directional inventory
risk that an AMM has and a CLOB doesn't?*

## Where the code lives
- `~/Desktop/amm-hedging` (this repo). GitHub `sidjainnn/AMM_Hedging` has docs +
  (after a merge) the code.
- Node is hand-installed at `~/.local/node` (no system node). PATH is in
  `~/.zshrc`; subprocesses need the absolute path.

## Architecture
```
src/sim/        deterministic sim core (pure TS, reused by web + server)
  engines/      LMSR · CPMM · LS-LMSR (price = f(inventory q), not feed-anchored)
  quoting.ts    manual + Avellaneda–Stoikov overlay
  market.ts     rolling tenors, ATM strike, order book, pair-mint/engine
  price.ts      synthetic GBM OR external live price (externalPrice flag)
  agents/       simple (v1) + behavioral (default): sporadic Poisson arrivals,
                heavy-tailed sizes, archetypes, FINITE WALLETS (reward fn),
                skill-weighted SENTIMENT
  hedging.ts    aggregate δ, σ√τ flatten, books A/B/C, P&L decomposition
  sim.ts        tick loop; userTrade(); feedPrice(); stress()
  backtest.ts / validate.ts   headless tools (force externalPrice:false)
src/ui/         React dashboard, 5 tabs:
  5m Market (Page5)  Polymarket-style single market + user wallet + controls
  Trading (Page1) · Hedge Overview (Page2) · Backtest (Page3) · Live demo (Page4)
server/         Node/Express backend (tsx): live Binance DEMO feed drives the
                sim server-side + places real demo perp orders
```

## What's built (done)
- Engines, quoting, rolling markets, behavioral agents.
- 3 hedge books: A pure-δ (true σ), B ride-bias, C pure-δ (est σ = the only
  *deployable* one). Delta = bump settlement-value of net inventory.
- Real-time pacing (1 tick = 1s), one ATM market per tenor (5/10/30m).
- Validation harness (`validate.ts`): invariant checks + thesis checks. KEY
  prior finding — delta hedge **smooths the equity curve & cuts trend drawdown
  but does NOT reduce cross-seed P&L variance** (that's adverse selection).
- Backtest page: 3-engine P&L comparison (LS-LMSR wins).
- **Live Binance demo**: backend runs the sim off the live feed; spot for
  UI/PnL, futures mark for hedging. Browser sim also uses the backend feed.
- **Auto demo perp trading**: `marketOrder()` → signed `POST /fapi/v1/order`;
  runner reconciles position every `HEDGE_INTERVAL_SEC`. Gated by `DRY_RUN`
  (default true) + Enable toggle + `MAX_POSITION_BTC` cap + mainnet hard-block.
- **User wallet** on 5m page (finite cash, position, equity, P&L).
- **Agent wallets = reward fn**: settle P&L per roll; broke→drop out;
  winners→bigger. `agentStats` shown on 5m page.
- **Information sentiment**: skill(wealth)-weighted net agent positioning →
  pSent + lean. Drives a **sentiment hedge mode** (perp ∝ smart-money lean)
  vs the delta mode plus a **combined** mode (delta + sentiment tilt, default).
  Live page shows the demo **account equity over time**.
- **5m page panels** (`Page5Market`): user wallet; **Hedge Risk Lab** (4 perp
  overlays with vol/maxDD); **P&L & money-flow panel** — agent P&L + MM P&L
  (incl. inventory loss), reconciled (MM net ≈ −agents net) because inventory is
  marked at engine pYes; **reset** flattens both parties to zero;
  **Binance hedge on/off button** (`useHedgeControl` → `/api/hedge/{status,
  enable}`; OFF by default, requires keys) — VERIFIED firing/stopping real demo
  orders, left OFF + flat.
- **Volatility gate on the live hedger**: only hedges when realized per-tick vol
  ≥ `HEDGE_VOL_THRESHOLD` (hysteresis on the way down), flat when calm — so the
  hedge runs only in regimes where it out-earns fees. Surfaced on the 5m page
  (armed/idle) + a `gated` overlay in the Hedge Risk Lab. See QA doc §B2.
- **5m profit optimization (sim-frozen, then live)** — QA §B3: invWiden spread
  widening + risk-tier hedge dial + per-tenor (5m=60s) lockout. Harness FULL:
  $77.9/window, 97%, worst −$43, std 49 (PASS). The live runner gates the demo
  hedge on BOTH the vol gate AND the inventory gate (`hedgeNotionalUsdt`, from the
  sim's risk-tier `idleReason`): fires only when calm-and-skewed conditions both
  clear → matches the risk-tiered sim. Status: armed / idle-vol / idle-inv /
  disabled (shown on 5m page; `/api/hedge/status`). Env overrides
  `HEDGE_NOTIONAL_USDT` / `HEDGE_TIER_LOW/HIGH` let ops recalibrate live without a
  recompile. The inventory gate is **adaptive by default** (`HEDGE_GATE_MODE`):
  gate = p60 of the last hour's notional exposure, floored at
  `HEDGE_NOTIONAL_USDT`, 5-min warmup, 0.6× hysteresis — so it keeps
  discriminating as flow/BTC level drift; the effective gate also drives the
  sim risk-tier staircase. Manual $ entry on the 5m page = fixed-mode override;
  `auto p60` button returns to adaptive.
- **Expiry gamma-wall fix** (binaries are short-gamma; perps can't hedge γ):
  pin-risk spread widening (`quote.gammaWiden`) + final-30s reduce-only lockout
  (`expiryLockoutTicks`) on the engine. A/B (64 windows, k=12): break-even rate
  78%→95%, worst −$74→−$56, variance −36%. 5m page shows a lockout banner. QA §F.
- **Break-even acceptance harness** (`src/sim/breakeven.ts`): 64 5-min windows,
  decomposes spread vs subsidy+adverse-selection vs hedge cost; set the k=12
  default. See hedging-validation-and-qa.md §E.

## How to run
```bash
# web
cd ~/Desktop/amm-hedging && npm run dev        # http://localhost:5173 (or 5174)
# backend (live demo)
cd server && cp .env.example .env              # add Binance DEMO keys (both!)
npm install && npm start                        # http://localhost:8787
# validate
npx esbuild src/sim/validate.ts --bundle --platform=node --format=esm \
  --outfile=/tmp/v.mjs && node /tmp/v.mjs
```
Keys ONLY in `server/.env` (gitignored). Demo futures wallet ~5k USDT (faucet).
`DRY_RUN=false` + Enable on Live tab = real demo orders.

## Locked decisions / honesty
- **Binance feed = single source of truth** for the BTC underlying. The AMM
  engine still prices the *binary* off inventory (f(q)), NOT anchored to the feed
  — needed for the inventory-hedging thesis. ("feed-free" branding is retired;
  it was a label for the engine mechanism, not the project.) Only Book C is
  deployable (A/B use true σ you lack live).
- Break-even: spread/vig must out-earn the LMSR subsidy (`b·ln2`/market) +
  adverse selection. Default tuned **b110, Stoikov k=12** (was k=25, which failed
  the 3-market 5m break-even); k=12 → +$71/window (95%) WITH the gamma-wall fix
  (§F: pin-risk widening + expiry lockout). Acceptance harness:
  `src/sim/breakeven.ts`; see hedging-validation-and-qa.md §E/§F.
- Demo/paper only; production hosts blocked in `server/src/config.ts`.

## NEXT STEPS (the plan to resume)
The thesis = "hedging the AMM inventory skew on perps solves the directional
inventory risk a CLOB avoids." Two costs of AMM inventory: **directional**
(hedgeable with perps) vs **adverse selection / subsidy** (only the vig pays).

1. **Quantify inventory-risk reduction** — run realistic agents, compare
   **unhedged vs delta-hedge vs sentiment-hedge** on **inventory-P&L variance +
   max drawdown**. Output: "hedging cuts directional risk by X%, residual =
   adverse selection." (Extend `validate.ts` / add a comparison view.) DO FIRST.
2. **Real informed-agent edge** — give the informed cohort a noisy peek at the
   forward return (tagged sim-ground-truth) so SENTIMENT carries genuine info;
   only then can the sentiment-hedge beat the model-hedge.
3. **Visualize** skew → delta → perp hedge → residual exposure on 5m/Live.
4. **Hedge frictions** — slippage + stochastic funding so the demo result is
   realistic (currently fill ≈ mark, funding constant).

## Experiment result (5×5min hedging) — [experiment-results.md](experiment-results.md)
Hedging the AMM liquidity skew on perps (full $10k budget) over 5 markets,
stressed across BTC outcomes on real Binance data: **delta/combined remove
~33–37% of P&L dispersion and turn the worst case from −$115 to +$85/+$109**;
**combined (delta + sentiment tilt) is best**, sentiment-alone weakest; residual
variance is adverse selection (unhedgeable). Live combined hedge verified placing
real demo orders (then flattened; back to DRY_RUN). Run:
`src/sim/experiment.ts`.

## QA guide — [qa-risks.md](qa-risks.md)
Expected behaviors (lockout gray-out, gated hedge idling, feed-freeze, ties pay
YES), honesty notes (paper book / real demo hedge), real risks (noise-flow
dependency is the one failing scenario), and the acceptance commands
(breakeven / validate / stress / experiment harnesses).

## QA / hedging-effectiveness — [hedging-validation-and-qa.md](hedging-validation-and-qa.md)
5m-market QA checklist + how to actually prove the hedge works: A/B (hedged vs
unhedged) on the demo venue across calm AND volatile periods, metric = risk
removed per $ of cost. Close slippage/funding/latency/churn gaps first or the
test overstates effectiveness.

## Deferred design
`docs/agents-implementation.md` — advanced agent reward (fractional-Kelly for
informed, CRRA/squared penalty for retail) + the precision-weighted sentiment
estimator. Revisit alongside step 2 above.
