> Engineering notes carried over from working sessions. Findings, root
> causes and decisions recorded as they were made — kept because the
> reasoning behind a fix is usually harder to recover than the fix.

The **AMM_Hedging** GitHub repo (github.com/sidjainnn/AMM_Hedging) contains only
design docs (`CLAUDE.md`, `docs/*.md`). The actual implementation was built
locally at `/Users/sidharthjain/Desktop/amm-hedging` (Vite + React + TS, Recharts).

Architecture: deterministic sim core in `src/sim/` (engines, quoting, market,
price, agents, hedging, sim orchestrator) + React dashboard in `src/ui/`
(Page1Trading, Page2Hedge). Reproducible from `config.seed`. See its README.

**Why:** the design (inventory-priced LMSR/CPMM/LS-LMSR AMM, Stoikov overlay,
synthetic BTC, three hedge books A/B/C) was fully spec'd in the docs and the user
asked to build it. Default scenario is tuned (seed 42, drift~0) so spread capture
vs adverse-selection inventory loss is visible.

It is now a git repo. Commit e4e8ff3 = hard rollback snapshot (simple agents
only); 9d0a7ac added the behavioral agent model.

Agents are swappable via `config.agentModel` + a Trading-page toggle:
`simple` (original v1, kept verbatim for rollback, byte-identical: seed42/8000t
= 3148) and `behavioral` (default — heterogeneous ~95-trader population, bursty
arrivals, heavy-tailed sizes, favorite-longshot/momentum/contrarian/informed,
references the spot/est-σ, not anchoring the engine). Both deterministic. Default
Stoikov spread is now **k=12** (was k=25) to clear break-even on the 3-market 5m
setup. See [[amm-breakeven-economics]].

Live Binance integration added: `server/` (Node/Express/tsx) runs the sim core
server-side off the live **Binance demo** feed (demo-fapi.binance.com) and
reconciles Book C's delta target as a real position on the demo futures venue.
Safety: hard mainnet block in `server/src/config.ts`, `DRY_RUN` default, hedge
enable-gate, `MAX_POSITION_BTC` cap; API keys live ONLY in `server/.env`
(gitignored — never commit). HMAC signing verified vs openssl. Sim core gained
an external-price mode (`SimConfig.externalPrice`, `price.feed()`). Frontend has
a 'Live (demo)' tab (`Page4Live` + `useLiveBackend`) consuming `/api/state` over
WS+poll. The live Binance feed is the single source of truth for the underlying
(synthetic feed retired, GBM = backtest fixture only); the AMM engine still
prices the binary off inventory (NOT anchored to the feed — "feed-free" branding
dropped). Golden rule #4 relaxed to demo venue.

Wallets: users have a finite wallet on the 5m page; agents have finite wallets
as a reward function (broke→drop out, winners trade bigger), settled per roll.

Information sentiment + sentiment hedge BUILT: skill(wealth)-weighted agent
positioning → pSent/lean (`BehavioralAgents.sentiment`); backend `hedgeMode`
delta|sentiment (perp ∝ smart-money lean); Live page shows real demo futures
account balance/equity over time + mode toggle. Auto demo perp orders via
`marketOrder` (signed `POST /fapi/v1/order`), reconciled each interval, gated by
DRY_RUN + Enable. Demo futures wallet ~5k USDT.

Hedge result (docs/experiment-results.md): 5×5min, real Binance windows, full
$10k budget, BTC-outcome stress → delta/combined remove ~33–37% of P&L
dispersion and turn worst-case from −$115 to +$85/+$109; **combined (delta +
sentiment tilt) best**, sentiment-alone weakest; residual = adverse selection
(unhedgeable). Live combined hedge VERIFIED placing real Binance demo orders
(then flattened; default back to DRY_RUN). hedgeMode delta|sentiment|combined,
notional cap MAX_NOTIONAL_USDT (~10k). Experiment: `src/sim/experiment.ts`;
break-even QA harness: `src/sim/breakeven.ts`.

5m page (`Page5Market`) now has: user wallet + position, a **Hedge Risk Lab**
(4 perp overlays with vol/maxDD), a **P&L & money-flow panel** (agent P&L + MM
P&L incl. inventory loss; both start flat after reset), and a **Binance hedge
on/off button** (`useHedgeControl` → `/api/hedge/{status,enable}`; OFF by default,
needs keys). MM/agent P&L reconcile because inventory is marked at engine pYes
(not trueSigma) — MM net ≈ −(agents net). hedgeMode default = combined.

**HANDOFF for new sessions: read `docs/STATUS.md` first** (full current state +
how to run + prioritized next steps). Thesis: hedge the AMM inventory skew on
perps to kill the directional inventory risk a CLOB avoids (adverse selection is
NOT hedgeable — only the vig pays for it). Next: (1) quantify unhedged vs delta
vs sentiment on inventory-P&L variance/drawdown; (2) give informed agents a real
forward-edge so sentiment carries info; (3) visualize skew→hedge→residual;
(4) hedge frictions. Advanced agent-reward design deferred in
`docs/agents-implementation.md` (fractional-Kelly informed, CRRA/squared retail,
precision-weighted sentiment).

**How to apply:** [[node-install-location]] is needed to run it. Web: `npm run dev`
(serves :5173), `npm run build` to typecheck. Server: `cd server && cp .env.example
.env` (add demo keys) `&& npm install && npm start` (:8787). To place real demo
orders set `DRY_RUN=false` and enable hedging from the Live tab. tsconfig had `erasableSyntaxOnly`
disabled to allow constructor parameter properties. For headless P&L experiments,
bundle a script with esbuild (`npx esbuild src/sim/x.ts --bundle --platform=node
--format=esm --outfile=/tmp/x.mjs && node /tmp/x.mjs`) — keep it inside src/ so
relative imports resolve.
