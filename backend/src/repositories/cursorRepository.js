/**
 * Cursor repository for the event processing pipeline.
 */

const { run } = require("./repoUtils");

const CURSOR_NAME = "default";

async function ensureCursor(client) {
  await run(
    `INSERT INTO event_cursor (name, last_processed_ledger)
     VALUES ($1, 0)
     ON CONFLICT DO NOTHING`,
    [CURSOR_NAME],
    client
  );
}

async function getLastProcessedLedger(client) {
  await ensureCursor(client);
  const { rows } = await run(
    `SELECT last_processed_ledger FROM event_cursor WHERE name = $1`,
    [CURSOR_NAME],
    client
  );
  return Number(rows[0]?.last_processed_ledger ?? 0);
}

async function persistLastProcessedLedger(lastProcessedLedger, client) {
  const { rows } = await run(
    `UPDATE event_cursor
     SET last_processed_ledger = $1
     WHERE name = $2
     RETURNING last_processed_ledger`,
    [lastProcessedLedger, CURSOR_NAME],
    client
  );
  if (!rows.length) {
    await ensureCursor(client);
    return persistLastProcessedLedger(lastProcessedLedger, client);
  }
  return Number(rows[0].last_processed_ledger);
}

module.exports = {
  getLastProcessedLedger,
  persistLastProcessedLedger,
};
