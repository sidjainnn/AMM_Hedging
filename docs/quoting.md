# Quoting Overlay (toggle)

A quoting layer sits on top of the engine price to generate displayed bid/ask. It **never mutates
inventory `q`** (golden rule #5) — it only changes the quotes shown to users. Two modes:

## Manual spread
Fixed half-spread around the engine price:
```
bid = P_engine - s/2
ask = P_engine + s/2
```
`s` is a user-set parameter.

## Avellaneda–Stoikov (inventory-aware)
Reservation price (note: time **remaining** `(T - t)`, not `T` — this is what makes it decay
correctly toward expiry and is the pin-risk mechanism for short windows):
```
r = P_engine - q * γ * σ^2 * (T - t)
```
Optimal spread includes the inventory/vol term AND a depth/adverse-selection term:
```
spread = γ * σ^2 * (T - t) + (2/γ) * ln(1 + γ/k)
```
Quotes are placed around `r` using `spread`.

Parameters are **user-set sliders, not from a feed** (feed-free constraint):
- `σ` — volatility (the key knob; also reused by the deployment-mode hedge delta in `docs/hedging.md`)
- `γ` — risk aversion
- `T` — horizon (use time-to-expiry of the window for `(T - t)`)
- `k` — order-arrival/depth parameter

## Role
Stoikov is the **primary internal (feed-free) inventory manager**: when the house is long YES it
lowers the YES quote / raises NO, paying users to trade it back toward flat. At this horizon,
**pricing is the first-line risk tool**; the external perp hedge (`docs/hedging.md`) is the
backstop for residual aggregate exposure, not the front line.

`P_engine` is always the engine's own price (feed-free) — there is no external mid to use.
