# Hedging Layer

> **⚠️ Current build adds (see `docs/STATUS.md`):** the **live backend** marks
> and executes against the **live Binance demo** feed and places **real demo
> perp orders** (signed `POST /fapi/v1/order`, gated by `DRY_RUN` + Enable +
> position cap) — not only in-memory notionals. A **sentiment hedge mode** was
> added: hold a BTC perp ∝ the prediction-market smart-money lean, selectable vs
> the delta hedge below. The settlement-value delta / three-book / flatten design
> below is otherwise as implemented.

Reacts in real time to the net skew agents create. Hedges the **aggregate** directional exposure
of the rolling book, not individual markets. All positions are **in-memory notionals marked
against the synthetic BTC price** — no real venues, no money (golden rule #4). Fees and funding
are *modeled*.

## Numerical settlement-value delta (engine-agnostic)
Do NOT bump the engine price to get delta — it is feed-free, so it wouldn't move and delta would
be zero. Instead bump the **expected settlement value of the house's net inventory**:
1. Take the house's net YES/NO inventory for a market.
2. Compute its expected settlement value at the current synthetic price `S`, given `σ` and `τ`
   (probability the window finishes "up" — an N(d2)-style or Monte-Carlo estimate).
3. Bump `S` by ±ε, recompute, `delta = ΔValue / ε`.

This is uniform across LMSR/CPMM/LS-LMSR because it is computed on the inventory's settlement
exposure, not the engine's price curve.

- **True-delta books (sim):** bump the **synthetic price**. Exact. `sim-ground-truth`.
- **Deployment-realism book:** no synthetic price allowed → use the **engine's own implied
  probability** (from `q`) as the moneyness proxy to approximate delta. `deployment-available`.

## Aggregate delta
Sum net delta across all live tenors of an underlying into one number, **re-derived fresh each
tick** (stateless; simplest). Staggered tenors make this aggregate smooth even when a single 5m
window is spiking near its close. Carry-optimization (trade only the *change* at each roll) is
**shelved** — revisit only if fresh-rederive turnover/fees prove too high in the sim.

Aggregation is **per underlying, per direction** (correlated markets net; uncorrelated ones,
e.g. BTC-up vs ETH-down, are hedged separately).

## T* flatten trigger as a function of σ
Hedge while the hedge is *stable*; stop once delta goes vertical near a window close (the gamma
wall), where re-hedging costs more than the risk removed. Threshold on the uncertainty window
`σ * sqrt(τ)`:
```
flatten when  σ * sqrt(τ) ≤ k_flat      ⇔      τ* = (k_flat / σ)^2
```
- Hold/track while `τ > τ*`; **flatten unconditionally on the clock** when `τ ≤ τ*`
  (flatten on TIME, never on whether the hedge is currently winning).
- High `σ` → larger `τ*` → flatten earlier. Low `σ` → smaller `τ*` → hedge closer to close.
- `k_flat` is the single tuning knob (≈ fee/spread ÷ risk-aversion); calibrate in the sim.
- Applied **per tenor**: when the 5m hits `τ*` it drops out of the aggregate; longer tenors carry
  the book. The portfolio absorbs any single window's singularity.

## The hedge dial `h`
`h` = fraction of the aggregate bias that is hedged. Perp target position:
```
target = -(1 - h) * bias        // bias = aggregate net delta (house's directional exposure sign)
```
- `h = 1` → fully hedge → **net to zero** (pure hedge).
- `h = 0` → don't hedge → fully carry the crowd's directional bet.
- `0 < h < 1` → hedge part, ride part.
- `h > 1` → over-hedge → bet *against* the crowd (fade).

"Disable the growing side" near a close is allowed as a **defensive** measure. *Loading* the side
you predict will win is **separate optional alpha**, not part of the hedge — flag it explicitly.

## Three parallel hedge books (same flow, separate P&L)
- **Book A** — `h = 1`, pure hedge, **true-delta**. Baseline: can we cleanly neutralize risk?
- **Book B** — `h < 1` (slider), ride-the-bias, **true-delta**. Tests crowd-signal alpha.
- **Book C** — `h = 1`, **σ/τ-approx-delta** (engine-implied probability as moneyness). Tests the
  *deployment* question: how much worse is hedging with no feed vs perfect delta?

A vs B = hedge-policy comparison. A vs C = deployment-realism cost. Default `h = 1`.

## Each hedge book tracks
- Notional perp position (signed BTC), entry/avg price.
- Realized + unrealized P&L (marked tick-to-tick against synthetic BTC).
- **Modeled fee** per hedge trade (taker bps) — subtracted from P&L, not paid.
- **Modeled funding**: 8-hour accrual, cap ±2% per period (Kalshi-style). Relevant mainly for the
  continuously-held aggregate position, not the short legs.
- Net P&L = the headline number.

## Hedge instrument posture
Model the perp as **unleveraged / fully-margined** (1:1 on delta). A hedge that can be liquidated
is not a hedge — fully-margined can't be liquidated by a price move, it just marks up/down against
the binary book. Reliability over capital efficiency (per Paras). Kalshi perps = regulated BTC-spot
perps (8h funding, ±2% cap); for hedging purposes they are the same instrument as a Binance/Bybit
perp. None of this trades for real in the sim — it is all modeled.

## P&L decomposition (for the dashboard)
```
MM P&L = spread capture  -  inventory loss  -  hedge cost  +  funding
```
Expose each component so the source of profit/loss is visible, not just the total.
