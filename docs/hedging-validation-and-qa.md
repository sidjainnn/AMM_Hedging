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

## TL;DR
The plumbing works and reconciles; **whether hedging is worth it is an empirical
question that only a costed A/B on the demo venue across volatile periods can
answer** — and we must add slippage/funding/latency first or the test lies.
