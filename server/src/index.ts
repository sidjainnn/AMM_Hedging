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

  const initial = await getSpotPrice();
  console.log(`[amm-server] initial spot price ${config.symbol} = ${initial}`);
  const runner = new Runner(initial);

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (_req, res) => res.json({ ok: true, dryRun: config.dryRun }));
  app.get('/api/price', (_req, res) => res.json({ price: runner.spotPrice, symbol: config.symbol }));
  app.get('/api/hedge/status', (_req, res) => res.json(runner.hedgeStatus()));
  app.get('/api/state', (_req, res) => res.json(runner.getState()));
  app.post('/api/hedge/enable', (req, res) => {
    const on = !!req.body?.enabled;
    runner.setHedgeEnabled(on);
    res.json({ hedgeEnabled: on, dryRun: config.dryRun });
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
