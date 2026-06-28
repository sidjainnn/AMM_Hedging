# amm-hedging server (live demo feed + hedging)

Runs the simulation core **server-side**, driven by the live **Binance demo**
price feed, and reconciles the hedge as a real position on the **demo futures
venue**. Pricing stays feed-free (the engine prices off inventory `q`; the live
price only marks P&L, settles markets, and informs agents). No real money —
demo/paper venues only, enforced in code.

## Setup

```bash
cd server
cp .env.example .env        # then edit .env with your Binance DEMO keys
npm install
npm start                   # http://localhost:8787
```

Then open the web app and go to the **Live (demo)** tab.

## Safety model (read this)

- **Demo only.** `config.ts` hard-blocks production hosts (`api.binance.com`,
  `fapi.binance.com`). It refuses to start if pointed at a real-money venue.
- **DRY_RUN=true by default.** No orders are sent — intended hedges are only
  logged. Set `DRY_RUN=false` in `.env` only when you want real *demo* orders.
- **Hedging is off until enabled.** Toggle it from the Live tab (or
  `POST /api/hedge/enable`). It also requires keys in `.env`.
- **Hard position cap.** `MAX_POSITION_BTC` clamps the hedge; the hedger refuses
  to exceed it.
- **Secrets stay on the server.** The API secret is only used to HMAC-sign
  requests in `binance.ts`; it is never sent to the browser and `.env` is
  gitignored.

## What hedges, and how

- The server runs the sim in real time (1 tick = 1 second), feeding it the live
  spot price; the futures **mark** price is used for hedge execution.
- Each `HEDGE_INTERVAL_SEC` it reconciles the demo futures position toward a
  target set by **`HEDGE_MODE`** via a rounded MARKET order (respecting
  `LOT_SIZE`/`MIN_NOTIONAL` from `exchangeInfo`):
  - **`delta`** — neutralise **Book C**'s settlement-value delta (est-σ).
  - **`sentiment`** (default) — hold a perp ∝ the smart-money lean
    (`lean × SENTIMENT_GAIN × MAX_POSITION_BTC`).
- It also polls the real **futures account** (`/fapi/v2/account`) for
  balance/equity and tracks an equity curve.

## Endpoints

- `GET /api/state` — full sim snapshot + `live` block (prices, account, position,
  sentiment, equity series, flags)
- `GET /api/price` — `{ price }` (the live spot, used by the browser sim)
- `GET /api/health`
- `POST /api/hedge/enable` `{ "enabled": true|false }`
- `POST /api/hedge/mode` `{ "mode": "delta" | "sentiment" }`
- `WS /ws` — pushes the same state each tick

## .env keys

See `.env.example`. Defaults: spot `demo-api.binance.com`, futures
`demo-fapi.binance.com`, `BTCUSDT`, `DRY_RUN=true`, `HEDGE_ENABLED=false`,
`MAX_POSITION_BTC=0.05`, `HEDGE_MODE=sentiment`, `SENTIMENT_GAIN=1`.
