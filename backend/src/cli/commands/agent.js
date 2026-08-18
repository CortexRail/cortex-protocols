/**
 * `agent ban <id> --reason <text>` / `agent unban <id>` — moderator+.
 *
 * The identifier is the agent's on-chain registration id (agents.id), the
 * same id every other agent-scoped route and command uses — an owner
 * wallet can control more than one agent, so the ban has to target the
 * specific agent record, not the wallet. The ban is consulted by
 * agentService.js on every agent write path (see registerAgent /
 * updateAgentReputation).
 */

const { authenticate } = require("../AuthGate");
const { withAudit } = require("../AuditTrail");
const agentRepository = require("../../repositories/agentRepository");
const agentBanRepository = require("../../repositories/agentBanRepository");

async function ban(id, reason) {
  const agentId = Number(id);
  if (!reason) {
    throw new Error("--reason is required");
  }

  const { publicKey, role } = authenticate({ minRole: "moderator" });

  return withAudit(
    { operator: publicKey, role, command: "agent ban", args: { id: agentId, reason } },
    async () => {
      const agent = await agentRepository.findById(agentId);
      if (!agent) {
        throw new Error(`agent ${agentId} not found`);
      }
      return agentBanRepository.ban(agentId, { reason, bannedBy: publicKey });
    }
  );
}

async function unban(id) {
  const agentId = Number(id);
  const { publicKey, role } = authenticate({ minRole: "moderator" });

  return withAudit(
    { operator: publicKey, role, command: "agent unban", args: { id: agentId } },
    async () => {
      const removed = await agentBanRepository.unban(agentId);
      if (!removed) {
        throw new Error(`agent ${agentId} has no active ban`);
      }
      return { agentId, unbanned: true };
    }
  );
}

module.exports = { ban, unban };
