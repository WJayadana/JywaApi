const express = require('express');
const crypto = require('node:crypto');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const digiflazzRoutes = require('./routes/digiflazz');
const depositRoutes = require('./routes/deposits');
const v1Routes = require('./routes/v1');
const { v1Router: v1StatsRouter, legacyRouter: statsRouter } = require('./routes/stats');
const scheduler = require('./services/scheduler');
const config = require('./config');
const db = require('./db');

scheduler.start();

process.once('SIGTERM', () => scheduler.stop());
process.once('SIGINT', () => scheduler.stop());

const app = express();

app.disable('x-powered-by');
// Behind Caddy reverse proxy: trust the first hop so req.ip reflects the real
// client (Caddy sets X-Forwarded-For), not 127.0.0.1.
app.set('trust proxy', 'loopback');
app.use(cors());

// Webhook must consume the RAW body for HMAC verification — mount it
// BEFORE the global express.json() so the stream isn't consumed twice.
app.post(
  '/api/digiflazz/webhook',
  express.raw({ type: 'application/json', limit: '100kb' }),
  (req, res) => {
    if (!config.digiflazz.webhookSecret) {
      return res.status(503).json({ error: 'ServiceUnavailable', message: 'DIGIFLAZZ_WEBHOOK_SECRET is not configured' });
    }
    const sigHeader = req.headers['x-hub-signature'];
    if (!sigHeader || typeof sigHeader !== 'string') {
      return res.status(401).json({ error: 'Unauthorized', message: 'missing X-Hub-Signature' });
    }
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body));
    const expected = 'sha1=' + crypto.createHmac('sha1', config.digiflazz.webhookSecret).update(raw).digest('hex');
    const sig = sigHeader.trim();
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return res.status(401).json({ error: 'Unauthorized', message: 'invalid signature' });
    }
    let parsed = null;
    try { parsed = JSON.parse(raw.toString()); } catch (_e) { /* leave null */ }
    return res.status(200).json({
      received: true,
      event: req.headers['x-digiflazz-event'] || null,
      data: (parsed && parsed.data) || parsed || null,
    });
  }
);

// GoBiz webhook — must consume raw body before express.json()
app.post('/api/gobiz/webhook', express.raw({ type: 'application/json', limit: '100kb' }), (req, res) => {
  const crypto = require('node:crypto');
  const gobiz = require('./services/gobiz-client');
  const db = require('./db');

  const signature = req.headers['x-signature'] || '';
  if (!gobiz.verifyWebhookSignature(req.body, signature)) {
    return res.status(401).json({ error: 'Unauthorized', message: 'invalid signature' });
  }

  let payload = null;
  try { payload = JSON.parse(req.body.toString()); } catch (_) {
    return res.status(400).json({ error: 'BadRequest', message: 'invalid JSON' });
  }

  const { id, status, order_id, amount, expected_amount } = payload || {};
  if (!id || !status) return res.status(400).json({ error: 'BadRequest', message: 'missing id or status' });

  // Find deposit by gobiz payment id via order_id metadata
  // order_id format: DP-{timestamp}-{user_id}
  const userId = order_id?.split('-').slice(2).join('-') || null;
  if (!userId) return res.status(400).json({ received: true });

  const deposit = db.prepare('SELECT * FROM deposits WHERE gobiz_payment_id = ?').get(id);
  if (!deposit) return res.status(404).json({ error: 'NotFound', message: 'deposit not found' });

  if (deposit.status !== 'pending') return res.status(200).json({ received: true, status: deposit.status });

  if (status === 'paid') {
    // Mark paid FIRST — idempotent lock prevents double credit
    const updated = db.prepare(
      "UPDATE deposits SET status = 'paid', paid_at = datetime('now') WHERE gobiz_payment_id = ? AND status = 'pending'"
    ).run(id);
    if (updated.changes === 0) return res.status(200).json({ received: true, status: 'already_processed' });
    // Atomically: credit balance + log mutation
    const runTx = db.transaction(() => {
      const user = db.prepare('SELECT id, balance FROM users WHERE id = ?').get(deposit.user_id);
      if (!user) return;
      const balanceBefore = user.balance || 0;
      db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(deposit.amount, deposit.user_id);
      db.prepare(`INSERT INTO mutations (id, user_id, type, direction, amount, balance_before, balance_after, note) VALUES (?,?,?,?,?,?,?,?)`).run(
        crypto.randomUUID(), deposit.user_id, 'deposit', '+', deposit.amount,
        balanceBefore, balanceBefore + deposit.amount,
        `QRIS Deposit ${deposit.expected_amount} → credited (gobiz: ${id})`
      );
      db.prepare("UPDATE deposits SET status = 'credited', credited_at = datetime('now') WHERE id = ?").run(deposit.id);
    });
    runTx();
  } else if (status === 'expired' || status === 'cancelled') {
    db.prepare(`UPDATE deposits SET status = ? WHERE id = ?`).run(status, deposit.id);
  }

  res.status(200).json({ received: true, status: 'ok' });
});

app.use(express.json({ limit: '100kb' }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'TooManyRequests', message: 'too many authentication attempts; try again later' },
});

app.get('/health', (_req, res) => {
  try {
    db.prepare('SELECT 1 AS ok').get();
    res.json({ status: 'ok', service: 'jywa-api', timestamp: new Date().toISOString() });
  } catch (_error) {
    res.status(503).json({ status: 'error', service: 'jywa-api' });
  }
});

app.get('/', (_req, res) => {
  res.json({ name: 'Jywa API', version: '1.0.0', health: '/health', docs: '/docs' });
});

// Serve OpenAPI spec and Swagger UI
app.get('/openapi.yaml', (_req, res) => {
  const specPath = path.join(__dirname, '..', 'openapi.yaml');
  res.setHeader('content-type', 'application/yaml; charset=utf-8');
  res.send(fs.readFileSync(specPath, 'utf-8'));
});

app.get('/docs', (_req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Jywa API Docs</title>
  <link rel="stylesheet" href="/swagger-ui/swagger-ui.css" />
  <style>
    html { box-sizing: border-box; }
    *, *:before, *:after { box-sizing: inherit; }
    body { margin: 0; padding: 0; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="/swagger-ui/swagger-ui-bundle.js"></script>
  <script>
    window.addEventListener('load', function() {
      SwaggerUIBundle({
        url: '/openapi.yaml',
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
        layout: 'BaseLayout',
        tryItOutEnabled: true,
        requestInterceptor: function(req) {
          // Inject API key from localStorage if present
          var key = localStorage.getItem('jywa_api_token');
          if (key && req.headers['Authorization'] === undefined) {
            req.headers['Authorization'] = 'Bearer ' + key;
          }
          return req;
        }
      });
    });
  </script>
</body>
</html>`);
});

// Swagger UI static (before routes so it takes precedence)
app.use('/swagger-ui', express.static(path.join(__dirname, '..', 'node_modules/swagger-ui-dist')));

// Public static files (CSS, images, etc.)
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/digiflazz', digiflazzRoutes);
app.use('/api/deposits', depositRoutes);
app.use('/api/v1/stats', require('./middleware/api-key').apiKeyAuth, v1StatsRouter);
app.use('/api/v1', v1Routes);
app.use('/api/stats', statsRouter);

app.use((_req, res) => {
  res.status(404).json({ error: 'NotFound', message: 'route not found' });
});

app.use((error, _req, res, _next) => {
  if (error instanceof SyntaxError && error.status === 400 && error.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'ValidationError', message: 'invalid JSON body' });
  }
  console.error(error);
  return res.status(500).json({ error: 'InternalServerError', message: 'internal server error' });
});

module.exports = app;
