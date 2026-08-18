/**
 * Agent stake repository — all SQL touching `agent_stakes` lives here.
 *
 * Rows mirror the collateral an address has locked in the agent_registry
 * contract; the pipeline keeps them in step with STAKED, UNSTAKED and
 * STAKE_SLASHED events.
 */

const { run, toMs, msParam } = require("./repoUtils");

const COLUMNS = `
  agent_address, token, amount, slashed, staked_at, updated_at
`;

function mapStake(row) {
  if (!row) return null;
  return {
    agentAddress: row.agent_address,
    token: row.token,
    amount: Number(row.amount),
    slashed: Number(row.slashed),
    stakedAt: toMs(row.staked_at),
    updatedAt: toMs(row.updated_at),
  };
}

/**
 * Set an address's locked collateral to `amount` (the on-chain total).
 */
async function upsert(stake, client) {
  const { agentAddress, token = "", amount = 0, slashed = 0, stakedAt } = stake;

  const { rows } = await run(
    `INSERT INTO agent_stakes (agent_address, token, amount, slashed, staked_at)
     VALUES ($1, $2, $3, $4, COALESCE(to_timestamp($5::double precision / 1000.0), now()))
     ON CONFLICT (agent_address) DO UPDATE SET
       token      = EXCLUDED.token,
       amount     = EXCLUDED.amount,
       slashed    = GREATEST(agent_stakes.slashed, EXCLUDED.slashed),
       updated_at = now()
     RETURNING ${COLUMNS}`,
    [agentAddress, token, amount, slashed, msParam(stakedAt)],
    client
  );
  return mapStake(rows[0]);
}

/**
 * Move `amount` from locked collateral into the slashed total.
 * Returns null when the address has no stake row.
 */
async function applySlash(agentAddress, amount, client) {
  const { rows } = await run(
    `UPDATE agent_stakes
        SET amount     = GREATEST(amount - $2, 0),
            slashed    = slashed + $2,
            updated_at = now()
      WHERE agent_address = $1
     RETURNING ${COLUMNS}`,
    [agentAddress, amount],
    client
  );
  return mapStake(rows[0]);
}

async function findByAddress(agentAddress, client) {
  const { rows } = await run(
    `SELECT ${COLUMNS} FROM agent_stakes WHERE agent_address = $1`,
    [agentAddress],
    client,
    "read"
  );
  return mapStake(rows[0]);
}

/**
 * Stakes for several addresses at once (used when rendering agent lists).
 */
async function findByAddresses(addresses = [], client) {
  if (addresses.length === 0) return [];
  const { rows } = await run(
    `SELECT ${COLUMNS} FROM agent_stakes WHERE agent_address = ANY($1::text[])`,
    [addresses],
    client,
    "read"
  );
  return rows.map(mapStake);
}

module.exports = { upsert, applySlash, findByAddress, findByAddresses };
