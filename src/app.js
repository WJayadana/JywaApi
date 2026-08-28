const express = require('express');
const crypto = require('node:crypto');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const digiflazzRoutes = require('./routes/digiflazz');
const config = require('./config');
const db = require('./db');

const app = express();

app.disable('x-powered-by');
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

// Serve OpenAPI spec and custom docs UI
app.get('/openapi.yaml', (_req, res) => {
  const specPath = path.join(__dirname, '..', 'openapi.yaml');
  res.setHeader('content-type', 'application/yaml; charset=utf-8');
  res.send(fs.readFileSync(specPath, 'utf-8'));
});

app.get('/docs', (_req, res) => {
  const docsPath = path.join(__dirname, '..', 'public', 'docs.html');
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.send(fs.readFileSync(docsPath, 'utf-8'));
});

app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/digiflazz', digiflazzRoutes);

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
