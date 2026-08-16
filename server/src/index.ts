import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import { config } from './config';
import { getSpotPrice } from './binance';
import { Runner } from './runner';

async function main() {
  console.log(`[amm-server] venue=${config.futuresBase} symbol=${config.symbol}`);
  console.log(`[amm-server] DRY_RUN=${config.dryRun}  HEDGE_ENABLED=${config.hedgeEnabled}  keys=${config.hasKeys()}`);
  if (!config.dryRun) console.log('[amm-server] ⚠️  DRY_RUN is OFF — real DEMO orders will be sent when hedging is enabled.');

  // Retry the initial price fetch — a transient DNS/network blip at boot must
  // not kill the server (observed: ENOTFOUND / fetch failed → hard exit that
  // stopped the live A/B run). Retry ~2 min, then start ANYWAY with a fallback
  // seed: the tick loop + stale-feed guard take over and self-correct on the
  // first successful fetch. Continuity > a perfect opening strike.
  const FALLBACK_BTC = parseFloat(process.env.FALLBACK_BTC ?? '100000');
  let initial = 0;
  for (let attempt = 1; attempt <= 40; attempt++) {
    try { initial = await getSpotPrice(); break; }
    catch (e) {
      console.warn(`[amm-server] initial price fetch failed (attempt ${attempt}/40), retrying in 3s:`, String(e).slice(0, 100));
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  if (!initial) {
    initial = FALLBACK_BTC;
    console.warn(`[amm-server] ⚠️ Binance unreachable at boot — starting with fallback $${initial}; the feed will self-correct once reachable.`);
  }
  console.log(`[amm-server] initial spot price ${config.symbol} = ${initial}`);
  const runner = new Runner(initial);

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (_req, res) => res.json({ ok: true, dryRun: config.dryRun }));
  app.get('/api/price', (_req, res) =>
    res.json({ price: runner.spotPrice, symbol: config.symbol, stale: runner.feedStale }));
  app.get('/api/hedge/status', (_req, res) => res.json(runner.hedgeStatus()));
  app.get('/api/state', (_req, res) => res.json(runner.getState()));
  // A/B window ledger — JSON for the UI table, raw CSV for Excel/Numbers.
  app.get('/api/ledger', (req, res) => {
    const limit = Math.min(500, parseInt(String(req.query.limit ?? '50'), 10) || 50);
    res.json({ rows: runner.ledger.rows(limit), csv: '/api/ledger.csv' });
  });
  app.get('/api/ledger.csv', (_req, res) => res.download(runner.ledger.csvPath(), 'ledger.csv'));
  app.post('/api/hedge/enable', (req, res) => {
    const on = !!req.body?.enabled;
    runner.setHedgeEnabled(on);
    res.json({ hedgeEnabled: on, dryRun: config.dryRun });
  });
  // A/B run: scheduler alternates hedged/unhedged blocks at window boundaries.
  app.post('/api/ab', (req, res) => {
    runner.setABRunning(!!req.body?.running);
    res.json(runner.hedgeStatus());
  });
  app.post('/api/hedge/leverage', async (req, res) => {
    const x = Number(req.body?.leverage);
    if (!isFinite(x)) return res.status(400).json({ error: 'leverage must be a number' });
    res.json(await runner.setLeverage(x));
  });
  app.post('/api/hedge/gates', (req, res) => {
    const { notionalUsdt, volThreshold, mode, pctl } = req.body ?? {};
    console.log('[amm-server] /api/hedge/gates', JSON.stringify(req.body));
    runner.setGates({
      notionalUsdt: typeof notionalUsdt === 'number' ? notionalUsdt : undefined,
      volThreshold: typeof volThreshold === 'number' ? volThreshold : undefined,
      mode: mode === 'adaptive' || mode === 'fixed' ? mode : undefined,
      pctl: typeof pctl === 'number' ? pctl : undefined,
    });
    res.json(runner.hedgeStatus());
  });
  app.post('/api/hedge/mode', (req, res) => {
    const m = req.body?.mode;
    const mode = m === 'sentiment' || m === 'combined' ? m : 'delta';
    runner.setHedgeMode(mode);
    res.json({ hedgeMode: mode });
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  runner.start(() => {
    const payload = JSON.stringify(runner.getState());
    for (const c of wss.clients) if (c.readyState === 1) c.send(payload);
  });

  server.listen(config.port, () => {
    console.log(`[amm-server] listening on http://localhost:${config.port}  (GET /api/state, WS /ws)`);
  });
}

main().catch((e) => {
  console.error('[amm-server] fatal:', e);
  process.exit(1);
});

// Once the sim + live A/B are running, a stray error in a timer callback (e.g. a
// disk EPERM, a transient fetch throw) must NOT kill the process — that would
// stop the multi-hour experiment. Log loudly and keep running. Startup errors
// still exit via main().catch above.
process.on('uncaughtException', (e) => console.error('[amm-server] uncaughtException (continuing):', e));
process.on('unhandledRejection', (e) => console.error('[amm-server] unhandledRejection (continuing):', e));
