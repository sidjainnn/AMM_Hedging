import 'dotenv/config';

// Production hosts are hard-blocked so this can never touch real money.
const MAINNET_HOSTS = ['api.binance.com', 'fapi.binance.com', 'api1.binance.com', 'api2.binance.com', 'api3.binance.com'];

function assertPaper(base: string, label: string): string {
  let host: string;
  try {
    host = new URL(base).host;
  } catch {
    throw new Error(`Invalid ${label} URL: ${base}`);
  }
  if (MAINNET_HOSTS.includes(host)) {
    throw new Error(
      `REFUSING TO START: ${label}=${base} is a PRODUCTION (real-money) host. ` +
        `This build only allows demo/testnet venues.`
    );
  }
  return base;
}

const env = process.env;

export const config = {
  apiKey: env.BINANCE_API_KEY ?? '',
  apiSecret: env.BINANCE_API_SECRET ?? '',
  spotBase: assertPaper(env.SPOT_BASE ?? 'https://demo-api.binance.com', 'SPOT_BASE'),
  futuresBase: assertPaper(env.FUTURES_BASE ?? 'https://demo-fapi.binance.com', 'FUTURES_BASE'),
  symbol: (env.SYMBOL ?? 'BTCUSDT').toUpperCase(),
  port: parseInt(env.PORT ?? '8787', 10),
  dryRun: (env.DRY_RUN ?? 'true').toLowerCase() !== 'false',
  hedgeEnabled: (env.HEDGE_ENABLED ?? 'false').toLowerCase() === 'true',
  maxPositionBtc: parseFloat(env.MAX_POSITION_BTC ?? '0.05'),
  hedgeIntervalSec: parseInt(env.HEDGE_INTERVAL_SEC ?? '10', 10),
  hasKeys(): boolean {
    return this.apiKey.length > 0 && this.apiSecret.length > 0;
  },
};
