/**
 * AuditTrail — wraps every state-changing cortex-admin command so intent is
 * durable before the command body runs.
 *
 * `withAudit` writes a 'pending' admin_actions row first, then runs the
 * command. If the command throws (including a crash mid-operation), the row
 * is stamped 'error' with the message; on success it's stamped 'success'
 * with the returned result. Either way, the row insertion happens before
 * any side effect the command performs, so `admin_actions` always reflects
 * what was attempted even when the attempt didn't finish.
 */

const adminActionRepository = require("../repositories/adminActionRepository");

async function withAudit({ operator, role, command, args = {} }, fn) {
  const action = await adminActionRepository.create({ operator, role, command, args });

  try {
    const result = await fn();
    await adminActionRepository.complete(action.id, { status: "success", result: result ?? null });
    return result;
  } catch (err) {
    await adminActionRepository.complete(action.id, { status: "error", error: err.message });
    throw err;
  }
}

module.exports = { withAudit };
