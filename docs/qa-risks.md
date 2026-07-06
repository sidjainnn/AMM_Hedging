# QA guide: expected behaviors, known limits, and what "broken" actually looks like

For the 5m-market QA run. Read this BEFORE filing bugs — several intentional
behaviors look like defects if you don't know the design. Companion to the
checklist in [hedging-validation-and-qa.md](hedging-validation-and-qa.md) §D.

## Expected behaviors (NOT bugs)

1. **One side grays out in the last 60s** (`🔒 YES/NO locked`). Reduce-only
   lockout at the gamma wall: trades that would GROW the house's one-sided
   inventory are rejected in the 5m's final 60s (30s for 10m/30m); trades that
   shrink it still fill. If the book is exactly balanced, BOTH sides can lock.
   Agents' trades are silently rejected under the same rule (volume thins near
   expiry by design).
2. **Spread widens near expiry and when the book is skewed.** `gammaWiden`
   charges for unhedgeable terminal gamma (peaks ATM into expiry); `invWiden`
   widens as `|netSkew|/b` grows. Quotes at flat inventory are unchanged.
3. **The hedge does ~nothing in calm/balanced markets.** The live hedge is
   gated: it only trades when the book's notional exposure ≥ the inventory gate
   (default $80, tunable on the 5m page) — and stays flat otherwise. Status
   shows `armed / idle-inv / idle-vol / disabled`. "Hedge on but no orders" +
   `idle-*` = working as designed.
4. **YES/NO odds can swing wildly while the hedge stays flat.** Flow-driven
   churn (crowd buying both sides) is NOT hedgeable and not supposed to be —
   only a *net one-sided* book carries BTC delta. The vig monetizes churn; the
   perp hedges skew.
5. **Turning the hedge OFF closes the perp position** (kill switch flattens to
   ~0). A residual ≤ $50-notional dust can remain (venue min-notional) — that's
   the exchange's floor, not a leak.
6. **Feed outage freezes market time.** If Binance is unreachable >15s
   (`FEED_STALE_SEC`), ticks stop — countdowns freeze, nothing settles — and
   resume on recovery (overdue markets then settle on the first FRESH price).
   The topbar shows "feed offline".
7. **Ties pay YES.** Contract is "BTC **≥** strike" — settlement uses `>=`.
8. **Mean P&L is slightly LOWER hedged than unhedged in calm windows.** A hedge
   is variance-reduction, not profit: it costs fees and gives up lucky tails.
   Judge it on drawdown/dispersion (Hedge Risk Lab), not net P&L in calm.

## What the numbers mean (honesty)

- **The order book is paper; only the hedge is real (demo).** Inventory comes
  from ~95 simulated agents priced off the real Binance spot. "MM P&L" = paper
  book + real demo hedge. The break-even claim (below) is a property of the
  simulated flow.
- **Break-even validated in sim** (`src/sim/breakeven.ts`, 64 windows, k=12,
  full optimization): **$81/window mean, 97% break-even, worst −$16**.
  Longevity: 8h continuous → income decays ~5%/h (agent wallets bleed; no
  re-population) but stays >2× break-even. Scenario matrix: calm/storm/jumps/
  trends/one-sided all pass; **toxic-only flow (no noise) FAILS** — see risks.

## Real risks to watch during QA

1. **Noise-flow dependency (the one failing scenario).** With noise intensity
   ~0.1 (nearly all informed/directional flow) the vig cannot cover adverse
   selection: mean $13/window, 60% break-even, worst −$88. Market-making is
   only solvent while uninformed flow exists. There is currently **no live
   toxicity metric** — if QA drives purely-informed flow, expect losses.
2. **Hedge realism gaps.** Sim hedge fills at mark: no slippage, no stochastic
   funding, no latency. Live demo fills close some of this; the sim verdict
   still overstates hedge quality (see QA doc §C).
3. **Sentiment mode has no genuine edge yet.** Simulated agents infer from the
   same price everyone sees; `sentiment`/`combined`'s tilt is a noisy proxy
   until the deferred informed-edge work (agents-implementation.md) lands.
4. **Restart behavior.** On boot the server flattens any inherited perp
   position if hedging is disabled (logged as a warning). The SIM state (books,
   agent wallets) resets on every restart — live P&L baselines restart too.
5. **Determinism doesn't hold on the live feed.** Seeds reproduce synthetic
   runs exactly; live runs are unrepeatable. "Steps to reproduce" for live
   issues = logs + timestamps, not seeds.
6. **Gate calibration is adaptive by default.** A fixed $ threshold can't
   discriminate against a moving exposure distribution (live notional ranged
   $69–700 vs the old $80 gate — always open). The inventory gate now
   self-calibrates: gate = the 60th percentile of the last hour's exposure
   (floored at `HEDGE_NOTIONAL_USDT`, 5-min warmup at the floor, hysteresis at
   0.6×gate) — so "hedge only the riskiest ~40% of periods" holds in any
   regime. Typing a $ in `tune gates →` switches to fixed mode (manual
   override); the `auto p60` button switches back. If QA sees the hedge always
   armed or never armed for >1h, check the mode and percentile first.

## Safety rails (verify, don't fear)

- Mainnet hosts hard-blocked at startup (`server/src/config.ts`).
- `DRY_RUN=true` default = no orders; Enable toggle required on top.
- Notional cap `MAX_NOTIONAL_USDT`; multi-assets margin ON (USDT+USDC ≈ $10.5k
  backs the hedge); leverage explicit, default **1x** (dropdown on 5m page).
- Keys live ONLY in `server/.env` (gitignored).

## How to run the acceptance checks

```bash
# break-even + optimization A/B + regime split
npx esbuild src/sim/breakeven.ts --bundle --platform=node --format=esm --outfile=/tmp/be.mjs && node /tmp/be.mjs
# invariants (8 checks) + thesis
npx esbuild src/sim/validate.ts --bundle --platform=node --format=esm --outfile=/tmp/v.mjs && node /tmp/v.mjs
# longevity + scenario matrix + engines
npx esbuild src/sim/stress.ts --bundle --platform=node --format=esm --outfile=/tmp/st.mjs && node /tmp/st.mjs
# real-Binance-data hedge stress
npx esbuild src/sim/experiment.ts --bundle --platform=node --format=esm --outfile=/tmp/exp.mjs && node /tmp/exp.mjs
```
Pass bars: breakeven mean ≥ $50/window, rate ≥ 90%, worst ≥ −$80; validate all
PASS; experiment dispersion-removed ≥ ~30% for delta/combined.
