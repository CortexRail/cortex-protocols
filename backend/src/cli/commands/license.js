/**
 * `license revoke <id> --reason <text>` — moderator+.
 */

const { authenticate } = require("../AuthGate");
const { withAudit } = require("../AuditTrail");
const licenseService = require("../../services/licenseService");

async function revoke(id, reason) {
  const licenseId = Number(id);
  if (!reason) {
    throw new Error("--reason is required");
  }

  const { publicKey, role } = authenticate({ minRole: "moderator" });

  return withAudit(
    { operator: publicKey, role, command: "license revoke", args: { id: licenseId, reason } },
    () => licenseService.revokeLicense(licenseId)
  );
}

module.exports = { revoke };
