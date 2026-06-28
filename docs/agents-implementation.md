# Agents — reward function & information-sentiment (DEFERRED)

**Status: parked.** Revisit *after* the hedging process is fully built. The
hedging results should inform how much agent realism we actually need (e.g., if
hedge P&L is dominated by frictions, ultra-realistic agent sentiment matters
less; if adverse selection dominates, the informed-agent model matters a lot).

This doc captures the design discussion so we can pick it up cold.

---

## What already exists (basic reward — shipped)

Agents have **finite wallets** and a settlement-driven reward (see
`src/sim/agents/behavioral.ts`):

- each `Trader` has `balance`, `startBalance`, and per-market `positions`
- marketable buys deduct cash and record the position; size is capped by
  affordable cash (finite wallet)
- on market settlement (`onSettled`) winning shares pay $1 each → wallet credited
- **penalty:** balance `< MIN_BALANCE` ⇒ weight 0 ⇒ the agent drops out of flow
- **incentive:** `wealthFactor = clamp(balance/startBalance, …)` scales both
  selection frequency and bet size ⇒ winners trade more/bigger
- `stats()` exposes population wealth (active / bankrupt / winners / totals)

This satisfies "penalised for losing, incentivised to gain." Everything below is
**refinement** on top of it.

---

## Q1 — Should the reward be "squared" (squared-drawdown penalty)?

A squared-drawdown / quadratic penalty = **mean-variance risk aversion**:
penalise `drawdown²` so large losses hurt convexly. Clean and differentiable.

**But it is NOT optimal for informed traders.** An informed trader has positive
edge; the growth-optimal sizing of an edge is the **Kelly criterion** (maximise
expected **log** wealth), not minimise squared drawdown. A quadratic penalty is
only a small-bet approximation to log-utility and makes an edge-holder
**systematically under-bet**, throwing away growth to suppress variance.

General framing — **CRRA utility** with risk-aversion γ:

| γ | behaviour | who it fits |
|---|---|---|
| 1 | log utility = **Kelly** (growth-optimal) | **informed** agents |
| >1 | progressively risk-averse (the "squared"/drawdown regime) | retail: noise / momentum / contrarian |
| →∞ | minimise variance, barely bet | extreme risk-aversion |

**Conclusion:** don't apply "squared" everywhere. Use **fractional-Kelly
(γ≈1)** for the informed cohort and **CRRA γ>1 (the squared-style penalty)** for
the retail archetypes. Heterogeneous risk preferences are themselves realistic.

---

## Q2 — Most optimised way to get *information sentiment* (smart-money signal)

Goal: a signal like what you'd read off a **public** market — infer true
probability from *which* wallets are trading, not just the price.

The statistically optimal aggregation is a **precision-weighted (skill-weighted)
average of trader positioning**:

```
sentiment = Σ_i  skill_i · lean_i   /   Σ_i skill_i
```

- `lean_i` = agent i's net YES/NO positioning (or recent order-flow direction)
- `skill_i` = estimate of how informed they are, from their **track record**

For `skill_i`, in increasing order of robustness:
1. realized P&L (noisy — overweights luck)
2. realized **log-wealth growth rate** (Kelly-consistent measure of edge)
3. hit-rate / Sharpe with **Bayesian shrinkage** toward the population mean
   (best — avoids crowning lucky agents)

Why it's the right signal: the engine **price lags** fair value (the sim shows
this: engine mid vs BTC-implied fair gap that arbs slowly close). A
skill-weighted positioning index **leads** the price toward fair value — a
cleaner probability estimate than the market price, and **deployable**: on a real
public market you'd compute `skill_i` from on-chain wallet history and weight
smart-money flow.

Note: weighting by `P&L²` (a "squared" skill weight) overweights luck/variance —
prefer a shrunk edge estimate or realized growth rate.

---

## Recommended build (when we return)

1. **Skill-weighted sentiment index** on the 5m page: agent positioning weighted
   by shrunk track-record skill; plot vs market mid and BTC-implied fair to show
   smart money leading price. *(highest value — directly answers Q2)*
2. **Fractional-Kelly sizing for informed agents** (reward = realized log-wealth
   growth) so the informed cohort's wealth diverges → sharper skill signal.
3. **CRRA γ>1 risk penalty for retail archetypes** (this is where the
   squared-drawdown idea belongs).
4. Track per-agent rolling skill stats needed for (1)–(2): realized growth,
   trade count, win rate (with shrinkage priors).

## Open questions for when we resume
- Does hedging care about sentiment quality, or just net delta? (decides priority)
- Should the sentiment index feed the quoting/hedging layer (e.g., a
  sentiment-aware reservation price), or stay a read-only research signal?
- Attribute pair-mint (limit-order) fills to specific agents for full wallet
  accounting? (currently only marketable engine trades are wallet-tracked)
