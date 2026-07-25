/**
 * Event log repository — all SQL touching the `events_log` table lives here.
 *
 * The log is append-only: raw on-chain events land here verbatim so the
 * index can always be rebuilt, audited, or replayed.
 */

const { run, toMs } = require("./repoUtils");

const COLUMNS = "id, ledger, contract_id, topic, payload, tx_hash, event_index, ingested_at";

function mapEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    ledger: row.ledger,
    contractId: row.contract_id,
    topic: row.topic,
    payload: row.payload,
    txHash: row.tx_hash,
    eventIndex: row.event_index,
    ingestedAt: toMs(row.ingested_at),
  };
}

/**
 * Append one raw event.
 */
async function append(event, client) {
  const {
    ledger,
    contractId,
    topic = [],
    payload = {},
    txHash = "",
    eventIndex = 0,
  } = event;

  const { rows } = await run(
    `INSERT INTO events_log (ledger, contract_id, topic, payload, tx_hash, event_index)
     VALUES ($1, $2, $3::text[], $4::jsonb, $5, $6)
     ON CONFLICT (contract_id, ledger, COALESCE(tx_hash, ''), event_index) DO NOTHING
     RETURNING ${COLUMNS}`,
    [ledger, contractId, topic, JSON.stringify(payload), txHash || "", eventIndex],
    client
  );
  // rows is empty when the event was already logged (unique constraint hit).
  return rows.length ? mapEvent(rows[0]) : null;
}

/**
 * Events strictly after the given ledger, oldest first.
 */
async function findSince(ledger, { limit = 100 } = {}, client) {
  const { rows } = await run(
    `SELECT ${COLUMNS} FROM events_log
     WHERE ledger > $1
     ORDER BY ledger ASC, id ASC
     LIMIT $2`,
    [ledger, limit],
    client
  );
  return rows.map(mapEvent);
}

/**
 * Events a specific contract emitted with the given topic tag.
 */
async function findByContractAndTopic(contractId, topic, { limit = 100 } = {}, client) {
  const { rows } = await run(
    `SELECT ${COLUMNS} FROM events_log
     WHERE contract_id = $1 AND topic @> ARRAY[$2]::text[]
     ORDER BY ledger ASC, id ASC
     LIMIT $3`,
    [contractId, topic, limit],
    client
  );
  return rows.map(mapEvent);
}

async function findByUniqueEvent(contractId, ledger, txHash, eventIndex, client) {
  const { rows } = await run(
    `SELECT ${COLUMNS} FROM events_log
     WHERE contract_id = $1
       AND ledger = $2
       AND COALESCE(tx_hash, '') = $3
       AND event_index = $4
     LIMIT 1`,
    [contractId, ledger, txHash || "", eventIndex],
    client
  );
  return rows.map(mapEvent);
}

/**
 * Highest ledger seen so far (0 when the log is empty) — the event
 * listener resumes from here after a restart.
 */
async function getLastLedger(client) {
  const { rows } = await run(
    "SELECT COALESCE(MAX(ledger), 0) AS last_ledger FROM events_log",
    [],
    client
  );
  return Number(rows[0].last_ledger);
}

module.exports = {
  append,
  findSince,
  findByContractAndTopic,
  findByUniqueEvent,
  getLastLedger,
};
