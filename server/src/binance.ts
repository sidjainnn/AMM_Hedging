import crypto from 'node:crypto';
import { config } from './config';

// -----------------------------
// Helpers
// -----------------------------
function qs(params: Record<string, string | number>): string {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
}

function sign(query: string): string {
  return crypto
    .createHmac('sha256', config.apiSecret)
    .update(query)
    .digest('hex');
}

async function publicGet<T>(
  base: string,
  path: string,
  params: Record<string, string | number> = {}
): Promise<T> {
  const url = `${base}${path}${Object.keys(params).length ? '?' + qs(params) : ''}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${path} ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

// -----------------------------
// SIGNED REQUESTS (trading only)
// -----------------------------
async function signedRequest<T>(
  base: string,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  params: Record<string, string | number> = {}
): Promise<T> {
  if (!config.hasKeys()) throw new Error('No API keys configured (.env)');

  const withTime = {
    ...params,
    timestamp: Date.now(),
    recvWindow: 5000,
  };

  const query = qs(withTime);
  const signature = sign(query);

  const url = `${base}${path}?${query}&signature=${signature}`;

  const res = await fetch(url, {
    method,
    headers: { 'X-MBX-APIKEY': config.apiKey },
  });

  if (!res.ok) throw new Error(`${path} ${res.status}: ${await res.text()}`);

  return res.json() as Promise<T>;
}

// ======================================================
// MARKET DATA (THIS IS THE FIX YOU NEEDED)
// ======================================================

// 1. SPOT PRICE (what users should SEE)
export async function getSpotPrice(): Promise<number> {
  const r = await publicGet<{ price: string }>(
    'https://api.binance.com',
    '/api/v3/ticker/price',
    { symbol: config.symbol }
  );

  return parseFloat(r.price);
}

// 2. FUTURES MARK PRICE (for hedging + risk engine)
// THIS replaces your incorrect /ticker/price usage
export async function getFuturesMarkPrice(): Promise<number> {
  const r = await publicGet<any>(
    config.futuresBase,
    '/fapi/v1/premiumIndex',
    { symbol: config.symbol }
  );

  return parseFloat(r.markPrice);
}

// 3. Combined snapshot (use this in WS / state)
export interface MarketData {
  spotPrice: number;
  futuresMarkPrice: number;
}

export async function getMarketData(): Promise<MarketData> {
  const [spot, mark] = await Promise.all([
    getSpotPrice(),
    getFuturesMarkPrice(),
  ]);

  return {
    spotPrice: spot,
    futuresMarkPrice: mark,
  };
}

// -----------------------------
// Filters (unchanged, but safe)
// -----------------------------
export interface SymbolFilters {
  stepSize: number;
  minQty: number;
  tickSize: number;
  minNotional: number;
  qtyPrecision: number;
}

let filtersCache: SymbolFilters | null = null;

export async function getFilters(): Promise<SymbolFilters> {
  if (filtersCache) return filtersCache;

  const info = await publicGet<any>(
    config.futuresBase,
    '/fapi/v1/exchangeInfo'
  );

  const sym = info.symbols.find((s: any) => s.symbol === config.symbol);
  if (!sym) throw new Error(`symbol ${config.symbol} not found`);

  const lot = sym.filters.find((f: any) => f.filterType === 'LOT_SIZE');
  const price = sym.filters.find((f: any) => f.filterType === 'PRICE_FILTER');
  const notional = sym.filters.find(
    (f: any) => f.filterType === 'MIN_NOTIONAL'
  );

  filtersCache = {
    stepSize: parseFloat(lot.stepSize),
    minQty: parseFloat(lot.minQty),
    tickSize: parseFloat(price.tickSize),
    minNotional: parseFloat(
      notional?.notional ?? notional?.minNotional ?? '5'
    ),
    qtyPrecision: sym.quantityPrecision,
  };

  return filtersCache;
}

export function roundToStep(qty: number, step: number): number {
  return Math.floor(Math.abs(qty) / step) * step * Math.sign(qty);
}

// -----------------------------
// ACCOUNT / TRADING (UNCHANGED)
// -----------------------------
export async function getPositionUnits(): Promise<number> {
  const r = await signedRequest<any[]>(
    config.futuresBase,
    'GET',
    '/fapi/v2/positionRisk',
    { symbol: config.symbol }
  );

  const p = Array.isArray(r)
    ? r.find((x) => x.symbol === config.symbol) ?? r[0]
    : r;

  return p ? parseFloat(p.positionAmt) : 0;
}

// Futures account snapshot (signed). USDⓈ-M figures are in USDT.
export interface FuturesAccount {
  walletBalance: number; // total wallet balance
  unrealizedPnl: number; // open-position mark-to-market
  equity: number; // margin balance = wallet + unrealized
  available: number; // free margin
}

export async function getAccount(): Promise<FuturesAccount> {
  const r = await signedRequest<any>(config.futuresBase, 'GET', '/fapi/v2/account', {});
  return {
    walletBalance: parseFloat(r.totalWalletBalance),
    unrealizedPnl: parseFloat(r.totalUnrealizedProfit),
    equity: parseFloat(r.totalMarginBalance),
    available: parseFloat(r.availableBalance),
  };
}

// Set leverage for the symbol (1x..125x). We default low (1x) because a hedge
// wants no leverage — sized to notional, not levered. Errors are surfaced to the
// caller to log (e.g. can't change with an open position on some venues).
export async function setLeverage(leverage: number): Promise<void> {
  if (!config.hasKeys()) return;
  await signedRequest(config.futuresBase, 'POST', '/fapi/v1/leverage', {
    symbol: config.symbol,
    leverage: Math.max(1, Math.round(leverage)),
  });
}

// Multi-Assets Mode lets USDC (and other stablecoins) cross-collateralize a
// USDT-margined position — so the full USDT+USDC balance backs BTCUSDT hedges.
// Can't be toggled while a position is open; caller logs the error if so.
export async function setMultiAssetsMargin(on: boolean): Promise<void> {
  if (!config.hasKeys()) return;
  await signedRequest(config.futuresBase, 'POST', '/fapi/v1/multiAssetsMargin', {
    multiAssetsMargin: on ? 'true' : 'false',
  });
}

export interface OrderResult {
  dryRun: boolean;
  side: 'BUY' | 'SELL';
  qty: number;
  avgPrice: number; // actual fill price (0 if dry-run/unknown) — for slippage measurement
  raw?: unknown;
}

export async function marketOrder(
  side: 'BUY' | 'SELL',
  qty: number
): Promise<OrderResult> {
  const f = await getFilters();

  const q = Math.abs(
    parseFloat(roundToStep(qty, f.stepSize).toFixed(f.qtyPrecision))
  );

  if (q < f.minQty) return { dryRun: config.dryRun, side, qty: 0, avgPrice: 0 };

  if (config.dryRun) return { dryRun: true, side, qty: q, avgPrice: 0 };

  const raw = await signedRequest<{ avgPrice?: string; orderId?: number }>(
    config.futuresBase, 'POST', '/fapi/v1/order', {
      symbol: config.symbol,
      side,
      type: 'MARKET',
      quantity: q,
      newOrderRespType: 'RESULT',
    });

  // The demo venue's POST response omits avgPrice/cumQuote, so query the order
  // back to get the actual fill price — the ledger measures realized slippage
  // (fill vs mark-at-decision) from it. Best-effort: on failure avgPrice=0 and
  // that fill's slippage is simply unmeasured rather than wrong.
  let avgPrice = parseFloat(raw?.avgPrice ?? '0') || 0;
  if (!avgPrice && raw?.orderId) {
    try {
      const q2 = await signedRequest<{ avgPrice?: string; cumQuote?: string; executedQty?: string }>(
        config.futuresBase, 'GET', '/fapi/v1/order', { symbol: config.symbol, orderId: raw.orderId });
      avgPrice = parseFloat(q2?.avgPrice ?? '0') || 0;
      if (!avgPrice) {
        const cum = parseFloat(q2?.cumQuote ?? '0');
        const ex = parseFloat(q2?.executedQty ?? '0');
        if (cum > 0 && ex > 0) avgPrice = cum / ex;
      }
    } catch { /* leave 0 — unmeasured */ }
  }

  return {
    dryRun: false,
    side,
    qty: q,
    avgPrice,
    raw,
  };
}