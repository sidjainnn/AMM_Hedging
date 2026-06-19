# Pricing Engines

Three deterministic engines, toggle between them per market. All are **binary** (YES + NO = 100,
init 50/50) and **feed-free**: price is a function of inventory only. Only trades against the
engine change inventory and therefore price (golden rule #2).

State convention: `qY`, `qN` = outstanding shares the engine has sold to traders (its inventory).

## LMSR (primary)
Cost function:
```
C(qY, qN) = b * ln( e^(qY/b) + e^(qN/b) )
```
Price:
```
P(YES) = e^(qY/b) / ( e^(qY/b) + e^(qN/b) )
P(NO)  = 1 - P(YES)
```
Trade cost (what the trader pays/receives for a fill that moves inventory): `ΔC = C(new) - C(old)`.

- `b` = liquidity parameter. Larger `b` → deeper book, flatter price impact, larger max loss.
- **Bounded loss** = `b * ln 2` for a binary market. This is the structural risk budget per market.
- Binary shorthand: with `q = qY - qN`, `P(YES) = 1 / (1 + e^(-q/b))`.

## CPMM (benchmark)
Constant product over YES/NO reserves:
```
x * y = k          // x = YES reserve, y = NO reserve
P(YES) = y / x
```
- **Seed at a prior** so a market need not open at 50/50: `x^p * y^(1-p) = C` (Manifold-style).
- Known limitation: the losing outcome token decays toward 0 at settlement (impermanent-loss
  analog). Fine as a baseline; do not treat CPMM as the strong binary engine.

## LS-LMSR (adaptive liquidity)
LMSR with a liquidity parameter that grows with open interest:
```
b(Q) = b0 + α * Q     // Q = total open interest (e.g. qY + qN)
```
- Early/thin market → small `b` → tight, responsive. Mature/deep market → larger `b` → stable.
- `α` also acts as a **built-in vig** (prices sum slightly > 1): this is LS-LMSR's profit knob.
- Note the regime distinction in `docs/decisions.md`: in AMM mode the vig IS the revenue model
  (unlike a matchmaker-fee framing).

## Inventory
Each engine tracks `qY`/`qN` per market. Inventory is the price state and the input the hedging
layer reads (via the settlement-value delta — see `docs/hedging.md`). The quoting overlay
(`docs/quoting.md`) reads the engine price but must never mutate inventory (golden rule #5).
