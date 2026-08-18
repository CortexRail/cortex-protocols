/**
 * `stream force-settle <id>` (moderator+) and `stream inspect <id>` (readonly).
 */

const { authenticate } = require("../AuthGate");
const { withAudit } = require("../AuditTrail");
const streamRepository = require("../../repositories/streamRepository");
const eventLogRepository = require("../../repositories/eventLogRepository");
const BatchSettler = require("../../protocol/BatchSettler");
const { CONTRACT_IDS } = require("../../config/stellar");

async function forceSettle(id) {
  const streamId = Number(id);
  const { publicKey, role } = authenticate({ minRole: "moderator" });

  return withAudit(
    { operator: publicKey, role, command: "stream force-settle", args: { id: streamId } },
    () => BatchSettler.forceSettleStream(streamId)
  );
}

/**
 * Dumps the indexed stream row plus its recent on-chain event history —
 * readonly, no audit entry (nothing is mutated).
 */
async function inspect(id) {
  const streamId = Number(id);
  authenticate({ minRole: "readonly" });

  const stream = await streamRepository.findById(streamId);
  if (!stream) {
    throw new Error(`stream ${streamId} not found`);
  }

  const recentEvents = CONTRACT_IDS.micropayments
    ? await eventLogRepository.findRecentByContract(CONTRACT_IDS.micropayments, { limit: 20 })
    : [];

  return { stream, recentEvents };
}

module.exports = { forceSettle, inspect };
