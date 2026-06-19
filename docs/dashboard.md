# Dashboard (two pages)

Both pages are views onto the **same** running in-memory simulation (same engine + synthetic-price
spine). Flip between them. Nothing touches real venues.

## Page 1 — Market / Trading Dashboard
"What is the engine doing right now."
- **Engine selector** per market: LMSR / CPMM / LS-LMSR (`docs/engines.md`).
- **Quoting toggle**: manual spread vs Stoikov, with σ/γ/T/k sliders (`docs/quoting.md`).
- **Order book**: resting YES/NO bids; live engine price; recent trades/tape.
- **Per-market state**: `qY`/`qN` inventory, engine P(YES)/P(NO), Stoikov reservation vs displayed
  quotes, net skew.
- **Rolling tenors**: the live 5m/10m/30m/1h windows with time-to-close and the next-roll countdown.
- **Synthetic BTC price**: visible chart, marked **sim-only** (`docs/agents.md`).
- **Agent controls**: mix/intensity of noise / directional / arbitrageur agents.

## Page 2 — Hedge Overview
"How are our positions holding up." This is the page to show Paras. **Read-only except** the
Book B `h` slider, the fee/funding assumptions, and the `k_flat` knob — resist adding more knobs.

- **Three book cards side by side** (A pure-hedge true-delta, B ride-bias true-delta, C pure-hedge
  approx-delta): position, entry/avg, unrealized P&L, realized P&L, accrued fees, accrued funding,
  **net P&L**. Lets you read A vs B (policy) and A vs C (deployment realism) at a glance.
- **P&L-over-time chart**: three lines (one per book) overlaid on the synthetic BTC price, so you
  can see *why* a line moved. Toggle to plot **components** instead of net (spread capture vs
  inventory loss vs hedge P&L vs funding) — see decomposition in `docs/hedging.md`.
- **Per-tenor breakdown**: a row per live tenor — net delta contribution, `τ`, and whether it is
  past `τ*` (flattened) or still tracked. Makes the staggered-tenor smoothing visible.
  Aggregate net delta shown at the top as the single number the hedge targets.
- **Hedge activity log**: recent hedge trades (tick, book, size, synthetic price marked at,
  modeled fee). Watch **turnover** — the trigger for revisiting carry-optimization.
- **Exposure / risk strip**: aggregate delta, live `τ*` threshold, time-to-next-roll, and a simple
  "worst case if BTC moves ±X%" per book.

## Principle
Value = seeing the mechanics clearly. Keep controls deliberate and few; everything else is display.
