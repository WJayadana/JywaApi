require('dotenv').config();

const express = require('express');
const cors = require('cors');

const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'jywa-api',
    timestamp: new Date().toISOString(),
  });
});

app.get('/', (_req, res) => {
  res.json({
    name: 'Jywa API',
    version: '1.0.0',
    health: '/health',
  });
});

app.listen(port, '127.0.0.1', () => {
  console.log(`Jywa API listening on http://127.0.0.1:${port}`);
});
