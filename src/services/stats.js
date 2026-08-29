const db = require('../db');

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Aggregate transaction stats for owner monitoring.
 * Sales/cost/profit only count `success` transactions; failed/pending are
 * reported as counts so the owner can see the funnel.
 */
function buildStats({ from, to }) {
  const where = [];
  const params = [];
  if (from) {
    where.push('created_at >= ?');
    params.push(`${from} 00:00:00`);
  }
  if (to) {
    where.push('created_at <= ?');
    params.push(`${to} 23:59:59`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const summary = db.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successful,
       SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
       COALESCE(SUM(CASE WHEN status = 'success' THEN harga       END), 0) AS total_sales,
       COALESCE(SUM(CASE WHEN status = 'success' THEN harga_modal END), 0) AS total_cost
     FROM transactions
     ${whereSql}`
  ).get(...params);

  const successWhere = whereSql
    ? `${whereSql} AND status = 'success'`
    : "WHERE status = 'success'";
  const topProducts = db.prepare(
    `SELECT sku,
            COUNT(*) AS sold,
            COALESCE(SUM(harga), 0)               AS revenue,
            COALESCE(SUM(harga_modal), 0)         AS cost,
            COALESCE(SUM(harga - harga_modal), 0) AS profit
       FROM transactions
       ${successWhere}
      GROUP BY sku
      ORDER BY revenue DESC, sku ASC
      LIMIT 10`
  ).all(...params);

  const totalSales = Number(summary.total_sales) || 0;
  const totalCost = Number(summary.total_cost) || 0;

  return {
    total_transactions: Number(summary.total) || 0,
    successful_transactions: Number(summary.successful) || 0,
    failed_transactions: Number(summary.failed) || 0,
    pending_transactions: Number(summary.pending) || 0,
    total_sales: totalSales,
    total_cost: totalCost,
    total_profit: totalSales - totalCost,
    top_products: topProducts.map((row) => ({
      sku: row.sku,
      sold: Number(row.sold) || 0,
      revenue: Number(row.revenue) || 0,
      cost: Number(row.cost) || 0,
      profit: Number(row.profit) || 0,
    })),
  };
}

/** Express handler shared by /api/v1/stats (API key) and /api/stats (JWT). */
function statsHandler(req, res) {
  const from = typeof req.query.from === 'string' ? req.query.from : null;
  const to = typeof req.query.to === 'string' ? req.query.to : null;
  if (from && !DATE_REGEX.test(from)) {
    return res.status(400).json({ error: 'ValidationError', message: 'from must be YYYY-MM-DD' });
  }
  if (to && !DATE_REGEX.test(to)) {
    return res.status(400).json({ error: 'ValidationError', message: 'to must be YYYY-MM-DD' });
  }
  if (from && to && from > to) {
    return res.status(400).json({ error: 'ValidationError', message: 'from must be <= to' });
  }
  return res.json(buildStats({ from, to }));
}

module.exports = { buildStats, statsHandler };
