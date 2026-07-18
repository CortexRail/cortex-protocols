/**
 * Event log repository — all SQL touching the `events_log` table lives here.
 *
 * The log is append-only: raw on-chain events land here verbatim so the
 * index can always be rebuilt, audited, or replayed.
 */

const { run, toMs } = require("./repoUtils");

const COLUMNS = "id, ledger, contract_id, topic, payload, tx_hash, ingested_at";

function mapEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    ledger: row.ledger,
    contractId: row.contract_id,
    topic: row.topic,
    payload: row.payload,
    txHash: row.tx_hash,
    ingestedAt: toMs(row.ingested_at),
  };
}

/**
 * Append one raw event.
 */
async function append(event, client) {
  const { ledger, contractId, topic = [], payload = {}, txHash = null } = event;

  const { rows } = await run(
    `INSERT INTO events_log (ledger, contract_id, topic, payload, tx_hash)
     VALUES ($1, $2, $3::text[], $4::jsonb, $5)
     RETURNING ${COLUMNS}`,
    [ledger, contractId, topic, JSON.stringify(payload), txHash],
    client
  );
  return mapEvent(rows[0]);
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

module.exports = { append, findSince, findByContractAndTopic, getLastLedger };
