const express = require('express');

const { buildStats, statsHandler } = require('../services/stats');

/**
 * Two mounting surfaces, exported separately:
 *  - v1Router    → /api/v1/stats (API key auth; caller role checked here)
 *  - legacyRouter → /api/stats (JWT auth + ownerOnly)
 */
const v1Router = express.Router();
v1Router.get('/', (req, res) => {
  if (req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Forbidden', message: 'stats is owner-only' });
  }
  return statsHandler(req, res);
});

const legacyRouter = express.Router();
const { authenticate, requireRole } = require('../middleware/auth');
legacyRouter.use(authenticate, requireRole('owner'));
legacyRouter.get('/', statsHandler);

module.exports = { v1Router, legacyRouter, buildStats, statsHandler };
