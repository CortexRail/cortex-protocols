/**
 * `contract pause|unpause <name>` — superadmin only.
 *
 * Toggles the off-chain `contract_state.paused` flag that services consult
 * before performing the write the named contract backs (today: licenseService
 * checks 'marketplace' before purchaseLicense). Recognized names match the
 * three deployed contracts in ../../config/stellar CONTRACT_IDS.
 *
 * NOTE: the Soroban contracts themselves don't yet expose an on-chain pause
 * entrypoint — that's tracked as follow-up work. This flag is the backend's
 * own enforcement point in the meantime, and every service that should
 * respect a pause needs its own `contractStateRepository.isPaused(name)`
 * check (see licenseService.purchaseLicense for the pattern).
 */

const { authenticate } = require("../AuthGate");
const { withAudit } = require("../AuditTrail");
const contractStateRepository = require("../../repositories/contractStateRepository");

const KNOWN_CONTRACTS = ["marketplace", "micropayments", "agent_registry"];

function assertKnownContract(name) {
  if (!KNOWN_CONTRACTS.includes(name)) {
    throw new Error(`unknown contract '${name}'; expected one of ${KNOWN_CONTRACTS.join(", ")}`);
  }
}

async function pause(name) {
  assertKnownContract(name);
  const { publicKey, role } = authenticate({ minRole: "superadmin" });

  return withAudit(
    { operator: publicKey, role, command: "contract pause", args: { name } },
    () => contractStateRepository.setPaused(name, true, publicKey)
  );
}

async function unpause(name) {
  assertKnownContract(name);
  const { publicKey, role } = authenticate({ minRole: "superadmin" });

  return withAudit(
    { operator: publicKey, role, command: "contract unpause", args: { name } },
    () => contractStateRepository.setPaused(name, false, publicKey)
  );
}

module.exports = { pause, unpause, KNOWN_CONTRACTS };
