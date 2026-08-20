/**
 * Agent funding repository — all SQL touching `agent_funding_sources`.
 *
 * The table is a cache of "who paid for this account's first inbound
 * payment", which SybilGraphDetector uses to tell a ring of wallets funded
 * from one place apart from a cluster of unrelated agents. Nothing populates
 * it yet (see migration 012): every read is written to tolerate a miss, and
 * the detector scores an unknown funding source at zero rather than guessing.
 */

const { run, toMs, msParam } = require("./repoUtils");

const COLUMNS = `
  agent_address, funding_source, first_funding_tx, first_funded_at, resolved_at
`;

function mapFundingSource(row) {
  if (!row) return null;
  return {
    agentAddress: row.agent_address,
    fundingSource: row.funding_source,
    firstFundingTx: row.first_funding_tx,
    firstFundedAt: toMs(row.first_funded_at),
    resolvedAt: toMs(row.resolved_at),
  };
}

/**
 * Record (or refresh) the funding source of an address.
 */
async function upsert(record, client) {
  const {
    agentAddress,
    fundingSource,
    firstFundingTx = null,
    firstFundedAt = null,
  } = record;

  const { rows } = await run(
    `INSERT INTO agent_funding_sources
       (agent_address, funding_source, first_funding_tx, first_funded_at)
     VALUES
       ($1, $2, $3, to_timestamp($4::double precision / 1000.0))
     ON CONFLICT (agent_address) DO UPDATE SET
       funding_source   = EXCLUDED.funding_source,
       first_funding_tx = EXCLUDED.first_funding_tx,
       first_funded_at  = EXCLUDED.first_funded_at,
       resolved_at      = now()
     RETURNING ${COLUMNS}`,
    [agentAddress, fundingSource, firstFundingTx, msParam(firstFundedAt)],
    client
  );
  return mapFundingSource(rows[0]);
}

/**
 * Look up several addresses at once. Addresses with no cached row are simply
 * absent from the result — callers must treat that as "unknown", never as
 * "unfunded".
 *
 * @param {string[]} addresses
 * @returns {Promise<Array<object>>}
 */
async function findByAddresses(addresses = [], client) {
  if (!addresses.length) return [];

  const { rows } = await run(
    `SELECT ${COLUMNS} FROM agent_funding_sources
     WHERE agent_address = ANY($1::text[])`,
    [addresses],
    client,
    "read"
  );
  return rows.map(mapFundingSource);
}

/**
 * Addresses sharing a given funding source — the "who else did this operator
 * pay for" lookup behind a sybil cluster's evidence.
 */
async function findBySource(fundingSource, client) {
  const { rows } = await run(
    `SELECT ${COLUMNS} FROM agent_funding_sources
     WHERE funding_source = $1
     ORDER BY first_funded_at NULLS LAST, agent_address`,
    [fundingSource],
    client,
    "read"
  );
  return rows.map(mapFundingSource);
}

module.exports = { upsert, findByAddresses, findBySource };
