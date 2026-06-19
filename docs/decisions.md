# Decisions & Rationale

*Why* the locked choices were made, and what is deliberately parked. Read this when a design
decision is being questioned or extended, so settled questions are not re-litigated.

## Locked decisions + rationale

- **Feed-free pricing.** Decision: the pricing engine uses no external spot price as an anchor.
  Rationale: a deliberate constraint for this phase. Oracle-anchoring (snapping the price to an
  N(d2) fair value from external spot) was researched and is powerful, but is explicitly OUT for
  pricing now. N(d2)-style logic survives only inside the hedge's settlement-value estimate, and
  even there the *deployment* book must use engine-implied probability, not external spot.

- **Only trades vs the engine move price; user↔user is price-neutral (pair-minting).** Rationale
  (business, from Paras): user↔user volume is what brings liquidity and users, and should not move
  the price. Price discovery is handed to **arbitrage** — arbitrageurs trading against the engine
  bring the information. This resolved the long-standing "user↔user at a different price looks
  wrong" tension: user↔user *reveals* mispricing (price-neutral), arbitrage *corrects* it.

- **Rolling, staggered tenors (5m/10m/30m/1h).** Rationale: markets roll (≈10s gap) rather than
  terminate, so the house's directional bias persists across windows and the hedge is one
  continuously-held book, not a per-window open/close. Staggering tenors smooths the aggregate
  delta so no single window's gamma wall is existential — the portfolio absorbs it.

- **Hedge the aggregate, re-derived fresh each tick.** Rationale: a single 1–5 min market is
  un-hedgeable near its close (0DTE gamma wall — confirmed in research: delta swings 0↔1, fees >
  premium). The aggregate net delta across tenors is slow and hedgeable. Fresh re-derive chosen
  for simplicity/statelessness; carry-optimization shelved unless turnover proves costly.

- **Numerical settlement-value delta.** Rationale: engine-agnostic and honest about what the sim
  can compute. Bumping the engine price would give zero (feed-free); bumping expected settlement
  value gives a real, uniform delta across all three engines.

- **T\* = (k_flat/σ)².** Rationale: hedge only while delta is stable; stop at the gamma wall.
  Threshold on σ·√τ so volatile markets flatten earlier, calm ones hedge closer to close. Flatten
  on the **clock**, not on P&L (exiting only when "up" keeps losing hedges open into the worst zone).

- **Three hedge books + the `h` dial.** Rationale: `h`=1 (net to zero) is the safe default — prove
  clean neutralization first. Book B (`h`<1) tests whether crowd bias predicts the next move
  (proprietary-sentiment alpha) — validated in-sim against the synthetic price BEFORE any real use.
  Book C (approx-delta) measures the real deployment cost of having no feed.

- **Unleveraged / fully-margined hedge.** Rationale (Paras): a hedge that can be liquidated is not
  a hedge. Optimize reliability over capital efficiency. Leverage chase explicitly rejected.

- **TypeScript + React, client-side sim.** Rationale: one language end to end (shared types),
  React fits the live stateful dashboard, no backend needed for a self-contained simulation.

- **IAMM dropped.** The behavioral-intelligence layer (trader/trade models, trade-quality-weighted
  control) was judged too complex to build from the start (Paras). May return post-v1.

## Parked / open items
- **Cold-start / no-arbitrageur staleness.** Under feed-free + arbitrage-driven discovery, a market
  with no arbitrageur present can sit stale. Handled in-sim by including arbitrageur agents; open as
  a deployment question (possible feed-free fallback to nudge price). Not blocking v1.
- **Carry-optimization at the roll.** Trade only the delta-change each roll instead of re-deriving.
  Deferred; revisit if turnover/fees are high.
- **Full user↔user matching design.** Pair-minting is the model; a fuller spec (priority inside the
  spread, etc.) is a future doc.
- **pm-AMM as a 4th engine.** Strong candidate (LVR-minimizing, prediction-market-specific) but not
  in v1's comparison set.
- **Crowd-signal alpha (Book B, `h`<1).** Promising but unproven; must show predictive power in-sim
  before any real-capital use. The most informed flow arrives near a close, so naive late-bias
  riding is dangerous.
- **"Benier niger" mechanism.** Manager-mentioned name; best guess is a Bayesian / Glosten-Milgrom
  learning market maker (price discovery from order-flow direction). Unconfirmed; not in v1.

## Research artifact
A separate deep-research report ("Market-Making Edges for a Crypto Binary Prediction Market") was
produced and covers oracle-anchoring, perp delta-hedging + funding carry/signal, options-surface
cross-checks, toxicity-scaled fees, batch auctions, etc. Much of it assumed a price feed; under the
current feed-free decision the hedging/funding/toxicity ideas survive and the oracle-anchored
pricing idea is demoted. Keep it as background, not as the v1 spec.
