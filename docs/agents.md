# Agents & Synthetic Price

> **⚠️ Current build differs (see `docs/STATUS.md`):**
> - Default model is **`behavioral`** (not the v1 set below): a persistent
>   heterogeneous population with **sporadic Poisson arrivals** (most ticks have
>   no trade), heavy-tailed sizes, archetypes noise / **momentum** / **contrarian**
>   / informed, **finite wallets as a reward function** (broke→drop out,
>   winners→bigger), and a **skill-weighted sentiment** signal. The v1 set below
>   survives as the `simple` model (rollback, Trading-page toggle).
> - The **synthetic GBM is off in the live path** — the BTC underlying is the
>   live Binance demo feed; est-σ is realised from real returns. (Synthetic GBM
>   remains only for the headless backtest/validate tools.)
> - Advanced reward + a precision-weighted sentiment estimator are deferred in
>   `docs/agents-implementation.md`.

Since the binary price comes from the AMM (inventory) and there are no real users, **agents are the
market** — they generate
all the flow, volume, and skew the dashboards visualize. Agent behavior is intentionally simple
for v1 and meant to be **retuned after the system is built and observable** (do not over-engineer
agents up front).

## Synthetic BTC price (sim ground truth)
A visible random walk driving the whole sim:
- Geometric Brownian motion with a vol parameter; optional jumps.
- **Shown on the dashboard, clearly marked "sim-only."**
- Triple duty: (1) agents reference it, (2) hedge P&L is marked against it, (3) it is the ground
  truth used to measure whether crowd bias has predictive signal.
- **Discipline (golden rule #6):** the synthetic price is `sim-ground-truth`. Only the
  true-delta hedge books may read it. Deployment-mode logic must rely on `σ/τ/own-flow` only.

## Agent set (v1)
1. **Noise traders** — random buys/sells; create baseline volume and user↔user (pair-mint) matches.
2. **Informed / directional agents** — biased one direction to deliberately create the **skew**
   under study; reference the synthetic price (e.g. lean YES when synthetic price is trending up).
3. **Arbitrageurs** — trade against the engine when its implied probability diverges from the
   synthetic-price-implied fair value. They perform price discovery and are what keep the engine
   from sitting stale (addresses the cold-start caveat in `docs/markets.md`).

Tune the **agent mix** to manufacture scenarios: balanced flow, one-sided ramp, volatility spike
near a window close, etc.

## What agents produce
- Order flow into the book (both matching channels).
- Net YES/NO inventory skew per market → aggregate net delta the hedging layer reacts to.
- A measurable relationship between aggregate crowd bias and the synthetic price's next move
  (used to evaluate the ride-the-bias hedge book — see `docs/hedging.md` and `docs/decisions.md`).
