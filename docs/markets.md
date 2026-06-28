# Markets, Order Book & Matching

> **⚠️ Current build differs from this spec (see `docs/STATUS.md`):**
> - Tenors are **5m / 10m / 30m** (the 1h was dropped).
> - **One ATM market per tenor** (no strike ladder); it settles **`BTC(t+τ) > K`**
>   where `K` = spot at creation — not the "up over the window" (close ≥ open)
>   comparator described below.
> - The underlying is the **live Binance demo feed**, not the synthetic price.
> - Order book: resting orders currently **only pair-mint**; the "swept when the
>   engine price moves to them" behaviour is NOT implemented yet.
> The rolling/pair-mint/engine-channel concepts below are still accurate.

## Rolling, staggered-tenor markets
Markets do **not** terminate and stay dead — they **roll**: a window runs, closes for a short
settlement gap (~10s), then a fresh window of the same tenor re-opens. The product is a *stream*
of short windows on the same underlying.

Open multiple tenors on one underlying **simultaneously**: e.g. **5m / 10m / 30m / 1h**. They are
all "BTC up over the window?" questions, so their directional biases are **correlated but
staggered** in time. This matters for hedging: the aggregate net delta across tenors is far
smoother than any single tenor (no single gamma cliff at one expiry), because the windows expire
at different times. See `docs/hedging.md`.

Each market: underlying (BTC), tenor/window length, open time, close time, comparator
("up over the window" = settles YES if synthetic price at close ≥ price at open). Settlement uses
the synthetic price at the exact close timestamp.

## Order book
- Displays resting **YES and NO bids**.
- The book is a ledger + execution layer, **not** a price-former. Price comes from the engine
  (golden rules #2, #3).
- Marketable orders (crossing the engine quote) fill immediately against the engine.
- Non-marketable orders rest and are **swept** when the engine price moves to them.

## Two matching channels
1. **User↔user (pair-minting).** Opposing YES/NO demand is matched into a $1 pair. The market
   maker stays flat; the engine's `q` does NOT change → **price-neutral** (golden rule #3). This
   is the volume channel that brings liquidity without house inventory.
2. **User↔engine.** Trades against the engine (including **arbitrage**) move `q` and therefore
   price, and give the MM inventory. This is the price-discovery channel.

A user↔user trade can *create* an arbitrage opportunity (e.g. heavy one-sided user↔user flow
signals the engine is stale); an arbitrageur then trades user↔engine to correct it. Thus
user↔user reveals information, arbitrage moves the price — no contradiction with "only trades vs
the engine move price."

## Cold-start caveat (known, parked)
If price only moves via arbitrage and no arbitrageur is present (thin/new market), the price can
sit stale. Acceptable for the sim (agents include arbitrageurs). Flagged in `docs/decisions.md`
as an open deployment item.
