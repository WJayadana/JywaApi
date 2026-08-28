const app = require('./src/app');
const { port } = require('./src/config');

const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Jywa API listening on http://127.0.0.1:${port}`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

module.exports = server;
