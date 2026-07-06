# Hedging effectiveness + 5m-market QA plan

## A. Is the hedge effective? (current honest verdict)
- Removes the **directional** part of the inventory/liquidity-skew risk; pays off
  in the **tails** (big BTC moves). Experiment: ~33–37% P&L-dispersion reduction,
  worst-case −$115 → +$85/+$109 across a BTC-outcome stress.
- **Conditional / unproven for production:**
  1. In calm windows the hedge **costs more than it saves** (fee + spread on each
     round-trip; combined/sentiment modes *churn*).
  2. The sim hedge is **too benign** — fills at mark, no slippage/funding/latency
     → it *overstates* effectiveness.
  3. A standalone **5-min binary is the worst case** to delta-hedge (gamma wall at
     expiry → σ√τ flatten). Real value is hedging the **aggregate across tenors**.

## B. How to test effectiveness (replicating real life)
The only valid test is an **A/B on the real (demo) venue**, not more sim.
- **Control:** unhedged AMM book P&L (counterfactual, already computed).
- **Treatment:** book + perp hedge with **real demo fills** (real spread, fees,
  funding).
- **Coverage:** many 5-min markets across **calm AND volatile** periods; the
  hedge only earns its keep in vol.
- **Metric:** risk removed per $ of cost — Δ(stdev), Δ(max drawdown),
  Δ(worst-case) **minus** fee+funding drag. Effective ⇔ removes more tail risk
  than it costs. (Mean P&L will be slightly *lower* hedged — that's expected.)
- **Significance:** ≥ ~50 markets + bootstrap CI (single-window β/σ is noisy —
  we observed 27–78% swings).
- **Stress:** replay historical volatile 5-min windows + the ±% BTC-outcome
  sweep (`src/sim/experiment.ts`).

## B2. Volatility gate (optimization — implemented)
A hedge only out-earns its round-trip fees when BTC moves enough; in calm windows
it's pure fee bleed (the Hedge Risk Lab makes this visible — unhedged beats the
always-on overlays). So the live hedger is **gated on realized vol**:
- Realized vol = stdev of per-tick simple returns over `HEDGE_VOL_WINDOW` ticks.
- Hedge target is applied only while vol ≥ `HEDGE_VOL_THRESHOLD`; below
  `THRESHOLD × HEDGE_VOL_HYSTERESIS` it flattens to 0 (hysteresis stops flapping,
  which would itself churn fees). Disable with `HEDGE_VOL_GATE=false`.
- Runner exposes `realizedVol / volThreshold / hedgeActive`; shown on the 5m page
  (hedge panel: "armed/idle") and as a 5th **`gated`** overlay in the Hedge Risk
  Lab — gated tracks unhedged when calm and switches to the combined hedge in vol.
- **Calibration:** read the live `realizedVol`, set `HEDGE_VOL_THRESHOLD` to the
  level where the lab's combined overlay starts beating unhedged on drawdown.

## B3. 5m profit optimization (implemented, sim-frozen)
Three coordinated levers tune the 5m MM for robust break-even while keeping quotes
competitive when flat. Tuned in `breakeven.ts` (synthetic), then run live unchanged.
1. **Inventory-proportional spread widening** (`quote.invWiden`, default 0.015;
   `invWiden5mBoost`=1.5) — half-spread grows with `|netSkew|/b`. 0 at flat (keeps
   liquidity competitive); pays users to close the gap as the house gets one-sided.
   Fixes `pinRisk` being zero ATM *and* at expiry. 5m gets a 50% bigger boost.
2. **Risk-tier hedge dial** (`hedgeNotionalUsdt`=200, `riskTierLow/High`=0.3/0.7) —
   Books A/C replace static h=1 with 0 / 0.3 / 0.7 / 1.0 as notional exposure rises
   (gate, 4×, 16×). Skips fee churn when little is at risk; full hedge in the tail.
3. **Per-tenor expiry lockout** (`expiryLockoutTicks5m`=60 vs 30 others) — 5m's
   gamma wall is sharpest, so it gets a longer reduce-only window.
- **A/B (64 windows, k=12, `breakeven.ts`):** baseline (gamma-wall only) $71.5/95%,
  worst −56, std 54 → **FULL $77.9/97%, worst −43, std 49**. Risk-tier cut hedge
  fee drag −$7.4→−$4.5. **Acceptance (mean≥$50, rate≥90%, worst≥−$80, std≤$80): PASS.**
- **Regime split (FULL):** calm (vol 0.0006) $82.4/98%; storm (0.0020) $92.5/98%.

## C. Realism gaps to close before trusting the verdict
- **Slippage / market impact** on hedge fills (esp. during spikes).
- **Stochastic funding** (paid per 8h, spikes when crowded).
- **Latency** (hedge on stale data/price).
- **Rebalance deadband + sentiment smoothing** (kill the churn fee drag).
- **Basis** (settlement index ≠ perp mark).

## D. 5m-market QA checklist
**Functional**
- [ ] 5m market rolls every 300 ticks; new ATM strike each roll; countdown correct.
- [ ] Settlement: YES iff BTC(expiry) ≥ K; payouts correct.
- [ ] P&L reconciles: MM net ≈ −(agents net) (engine-marked); no NaN/Inf.
- [ ] User wallet: finite, can't overspend, settles on roll; Reset flattens both
      parties to zero.
- [ ] Engine/quoting/agent toggles apply live; switching engine resets inventory.
- [ ] Live price = Binance feed (source of truth); "feed offline" if backend down.

**Hedging / venue (demo)**
- [ ] Orders place + reconcile on demo futures; signed requests succeed.
- [ ] Position cap (MAX_NOTIONAL_USDT) respected; never exceeds budget.
- [ ] DRY_RUN default = no orders; Enable required; mode toggle works.
- [ ] Kill switch (disable) stops trading; flatten leaves ~0 position.
- [ ] Mainnet hosts hard-blocked; keys only in server/.env.
- [ ] Reconnect: backend/WS drop → frontend recovers; position refresh resumes.

**Effectiveness (the real question)**
- [ ] Run hedged vs unhedged A/B on demo over ≥50 markets incl. a volatile day.
- [ ] Report risk-removed-per-$-cost with bootstrap CI.
- [ ] Confirm the hedge helps in vol and is ~flat-to-slightly-negative in calm
      (expected) — net acceptable after costs.

## E. Break-even acceptance test (spread + hedge ≥ 0 on the 5m market)
Run `src/sim/breakeven.ts` — 64 5-minute windows, delta hedge ON, decomposed
into spread (revenue) vs inventory subsidy+adverse-selection vs hedge cost.
- **Pass criterion:** mean net per 5-minute window ≥ 0 **and** break-even rate
  ≥ ~60% (calm), then re-check tail behaviour on volatile windows (`experiment.ts`).
- **The only guarantee lever is the spread (vig).** With one ATM market per tenor:
  k=25 → +$16/window (66%); **k=12 → +$71/window (95%, default)**; k=9 → +$97 (97%).
- Other levers: lower `b` (smaller LMSR subsidy/market) or more noise volume
  (more spread income) — but spread width is the controllable guarantee.
- **Trade-off:** wider spread = break-even cushion but less competitive quotes.

## F. Expiry gamma wall (fixed — see §B2 hedging can't solve this)
A 5-min binary's terminal risk is **gamma**, not delta: near expiry the digital's
`dp/dS ≈ φ(d)/(Sσ√τ)` blows up around the strike and a **linear perp can't hedge
it** (and the σ√τ trigger has already flattened it). The loss is adverse selection
at the pin, made worse by the Stoikov spread *collapsing* to its floor as τ→0.
Two quoting/risk fixes (not hedging) restore break-even:
1. **Pin-risk spread widening** (`quote.gammaWiden`, default 0.03) — adds a
   half-spread term `∝ p(1−p)/√τ̂` that surges into expiry near the strike, so the
   vig pays for the gamma taken. Lifts mean P&L.
2. **Expiry reduce-only lockout** (`expiryLockoutTicks`, default 30 = last 30s) —
   the engine accepts only inventory-*reducing* trades in the final window, so the
   house stops taking toxic inventory at the wall. Crushes the tail/variance.
- **A/B (64 windows, k=12, `breakeven.ts`):** off → $50.7/window, 78%, worst −$74,
  std 84. widen-only → $83.2, 92%. lockout-only → $57.4, 92%, std 52.
  **both (default) → $71.5/window, 95%, worst −$56, std 54** (−36% variance).

## TL;DR
The plumbing works and reconciles; **whether hedging is worth it is an empirical
question that only a costed A/B on the demo venue across volatile periods can
answer** — and we must add slippage/funding/latency first or the test lies.
