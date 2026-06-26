import crypto from 'node:crypto';
import { config } from './config';

// ---- low-level helpers ----
function qs(params: Record<string, string | number>): string {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
}

function sign(query: string): string {
  return crypto.createHmac('sha256', config.apiSecret).update(query).digest('hex');
}

async function publicGet<T>(base: string, path: string, params: Record<string, string | number> = {}): Promise<T> {
  const url = `${base}${path}${Object.keys(params).length ? '?' + qs(params) : ''}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${path} ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

// Signed request (HMAC-SHA256). Used for positions & orders. Secret never
// leaves the server; the browser never sees it.
async function signedRequest<T>(
  base: string,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  params: Record<string, string | number> = {}
): Promise<T> {
  if (!config.hasKeys()) throw new Error('No API keys configured (.env)');
  const withTime = { ...params, timestamp: Date.now(), recvWindow: 5000 };
  const query = qs(withTime);
  const signature = sign(query);
  const url = `${base}${path}?${query}&signature=${signature}`;
  const res = await fetch(url, { method, headers: { 'X-MBX-APIKEY': config.apiKey } });
  if (!res.ok) throw new Error(`${path} ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

// ---- market data (public, no key) ----
export async function getMarkPrice(): Promise<number> {
  const r = await publicGet<{ price: string }>(config.futuresBase, '/fapi/v1/ticker/price', { symbol: config.symbol });
  return parseFloat(r.price);
}

export interface SymbolFilters {
  stepSize: number; // LOT_SIZE quantity increment
  minQty: number;
  tickSize: number; // PRICE_FILTER
  minNotional: number;
  qtyPrecision: number;
}

let filtersCache: SymbolFilters | null = null;
export async function getFilters(): Promise<SymbolFilters> {
  if (filtersCache) return filtersCache;
  const info = await publicGet<any>(config.futuresBase, '/fapi/v1/exchangeInfo');
  const sym = info.symbols.find((s: any) => s.symbol === config.symbol);
  if (!sym) throw new Error(`symbol ${config.symbol} not found in exchangeInfo`);
  const lot = sym.filters.find((f: any) => f.filterType === 'LOT_SIZE');
  const price = sym.filters.find((f: any) => f.filterType === 'PRICE_FILTER');
  const notional = sym.filters.find((f: any) => f.filterType === 'MIN_NOTIONAL');
  filtersCache = {
    stepSize: parseFloat(lot.stepSize),
    minQty: parseFloat(lot.minQty),
    tickSize: parseFloat(price.tickSize),
    minNotional: parseFloat(notional?.notional ?? notional?.minNotional ?? '5'),
    qtyPrecision: sym.quantityPrecision,
  };
  return filtersCache;
}

export function roundToStep(qty: number, step: number): number {
  return Math.floor(Math.abs(qty) / step) * step * Math.sign(qty);
}

// ---- account / trading (signed) ----
export async function getPositionUnits(): Promise<number> {
  const r = await signedRequest<any[]>(config.futuresBase, 'GET', '/fapi/v2/positionRisk', { symbol: config.symbol });
  const p = Array.isArray(r) ? r.find((x) => x.symbol === config.symbol) ?? r[0] : r;
  return p ? parseFloat(p.positionAmt) : 0;
}

export interface OrderResult {
  dryRun: boolean;
  side: 'BUY' | 'SELL';
  qty: number;
  raw?: unknown;
}

// Places a MARKET order to adjust the futures position. Respects DRY_RUN.
export async function marketOrder(side: 'BUY' | 'SELL', qty: number): Promise<OrderResult> {
  const f = await getFilters();
  const q = Math.abs(parseFloat(roundToStep(qty, f.stepSize).toFixed(f.qtyPrecision)));
  if (q < f.minQty) return { dryRun: config.dryRun, side, qty: 0 }; // below tradable size
  if (config.dryRun) return { dryRun: true, side, qty: q };
  const raw = await signedRequest(config.futuresBase, 'POST', '/fapi/v1/order', {
    symbol: config.symbol,
    side,
    type: 'MARKET',
    quantity: q,
  });
  return { dryRun: false, side, qty: q, raw };
}
