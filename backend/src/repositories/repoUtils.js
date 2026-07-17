/**
 * Shared plumbing for the repository layer.
 *
 * Repositories are the ONLY place raw SQL is allowed. Every repository
 * function accepts an optional trailing `client` argument (a checked-out
 * pg PoolClient) so it can participate in a caller-managed transaction;
 * without it, queries run directly on the shared pool.
 */

const db = require("../db/connection");

/**
 * Execute a query on the given client if provided, otherwise on the pool.
 */
function run(text, params, client) {
  return client ? client.query(text, params) : db.query(text, params);
}

/**
 * TIMESTAMPTZ → epoch milliseconds (the shape the pre-Postgres API exposed).
 */
function toMs(value) {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.getTime() : Number(value);
}

/**
 * Epoch milliseconds → value usable as a to_timestamp($n / 1000.0) param.
 */
function msParam(value) {
  return value === null || value === undefined ? null : Number(value);
}

/**
 * Normalize page/limit into safe integers.
 */
function normalizePagination({ page = 1, limit = 20 } = {}) {
  const safePage = Math.max(1, Math.trunc(Number(page)) || 1);
  const safeLimit = Math.min(100, Math.max(1, Math.trunc(Number(limit)) || 20));
  return { page: safePage, limit: safeLimit, offset: (safePage - 1) * safeLimit };
}

function buildMeta(total, page, limit) {
  return { total, page, limit, pages: Math.ceil(total / limit) };
}

/**
 * Escape LIKE/ILIKE wildcards in user-supplied search terms.
 */
function escapeLike(term) {
  return String(term).replace(/[\\%_]/g, (c) => `\\${c}`);
}

module.exports = { run, toMs, msParam, normalizePagination, buildMeta, escapeLike };
