/**
 * `events replay --from-ledger <n> --to-ledger <m>` — superadmin only.
 *
 * Re-runs already-ingested raw events (events_log) through EventProcessor
 * for a historical ledger range — recovery from a processing bug that's
 * since been fixed, without re-fetching from RPC or touching the live
 * pipeline cursor.
 */

const { authenticate } = require("../AuthGate");
const { withAudit } = require("../AuditTrail");
const EventPipeline = require("../../pipeline/EventPipeline");

async function replay(fromLedger, toLedger) {
  const from = Number(fromLedger);
  const to = Number(toLedger);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) {
    throw new Error("--from-ledger must be an integer <= --to-ledger");
  }

  const { publicKey, role } = authenticate({ minRole: "superadmin" });

  return withAudit(
    { operator: publicKey, role, command: "events replay", args: { fromLedger: from, toLedger: to } },
    () => EventPipeline.replayLedgerRange(from, to)
  );
}

module.exports = { replay };
