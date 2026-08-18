#!/usr/bin/env node

/**
 * cortex-admin — the operator CLI for Cortex Protocol.
 *
 * Every subcommand goes through AuthGate (signs a challenge with
 * OPERATOR_SECRET_KEY, checks the resulting key + role against the
 * operator allowlist) and, for state-changing commands, AuditTrail (writes
 * an admin_actions row before executing). See AuthGate.js and
 * AuditTrail.js for the mechanics; commands/*.js wire them into each
 * operation.
 *
 *   cortex-admin contract pause <name>
 *   cortex-admin contract unpause <name>
 *   cortex-admin stream force-settle <id>
 *   cortex-admin stream inspect <id>
 *   cortex-admin agent ban <id> --reason <text>
 *   cortex-admin agent unban <id>
 *   cortex-admin license revoke <id> --reason <text>
 *   cortex-admin events replay --from-ledger <n> --to-ledger <m>
 *   cortex-admin dashboard
 */

require("dotenv").config();
const { Command } = require("commander");
const { closePool } = require("../db/connection");

const contractCmd = require("./commands/contract");
const streamCmd = require("./commands/stream");
const agentCmd = require("./commands/agent");
const licenseCmd = require("./commands/license");
const eventsCmd = require("./commands/events");

const program = new Command();
program.name("cortex-admin").description("Cortex Protocol operator CLI").version("0.1.0");

function printResult(result) {
  console.log(JSON.stringify(result, null, 2));
}

/**
 * Wraps a command action so auth/audit/business errors print a single
 * clean line instead of a raw stack trace, and the pg pool always drains
 * before the process exits (this is a short-lived CLI process, not the
 * long-running server).
 */
function action(fn) {
  return async (...args) => {
    try {
      const result = await fn(...args);
      printResult(result);
    } catch (err) {
      console.error(`cortex-admin: ${err.message}`);
      process.exitCode = 1;
    } finally {
      await closePool();
    }
  };
}

const contract = program.command("contract").description("Pause/unpause protocol contracts (superadmin)");
contract
  .command("pause <name>")
  .description("Pause a contract's write path")
  .action(action((name) => contractCmd.pause(name)));
contract
  .command("unpause <name>")
  .description("Unpause a contract's write path")
  .action(action((name) => contractCmd.unpause(name)));

const stream = program.command("stream").description("Payment stream operations");
stream
  .command("force-settle <id>")
  .description("Force-settle a stuck stream outside its normal schedule (moderator+)")
  .action(action((id) => streamCmd.forceSettle(id)));
stream
  .command("inspect <id>")
  .description("Dump full on-chain + off-chain state for a stream (readonly)")
  .action(action((id) => streamCmd.inspect(id)));

const agent = program.command("agent").description("Agent moderation");
agent
  .command("ban <id>")
  .description("Ban an agent from all write paths (moderator+)")
  .requiredOption("--reason <text>", "reason for the ban")
  .action(action((id, opts) => agentCmd.ban(id, opts.reason)));
agent
  .command("unban <id>")
  .description("Lift an agent ban (moderator+)")
  .action(action((id) => agentCmd.unban(id)));

const license = program.command("license").description("License moderation");
license
  .command("revoke <id>")
  .description("Zero a license's remaining metered calls (moderator+)")
  .requiredOption("--reason <text>", "reason for revocation")
  .action(action((id, opts) => licenseCmd.revoke(id, opts.reason)));

const events = program.command("events").description("Event pipeline recovery");
events
  .command("replay")
  .description("Re-run the pipeline over a historical ledger range (superadmin)")
  .requiredOption("--from-ledger <n>", "first ledger (inclusive)")
  .requiredOption("--to-ledger <n>", "last ledger (inclusive)")
  .action(action((opts) => eventsCmd.replay(opts.fromLedger, opts.toLedger)));

program
  .command("dashboard")
  .description("Launch the live operator TUI")
  .option("--refresh-ms <n>", "panel refresh interval in ms", "3000")
  .action(async (opts) => {
    // The TUI owns the process until the operator quits — no closePool()
    // here, dashboard.js's own key handler exits the process.
    const dashboard = require("./tui/dashboard");
    try {
      dashboard.start({ refreshIntervalMs: Number(opts.refreshMs) });
    } catch (err) {
      console.error(`cortex-admin: ${err.message}`);
      process.exitCode = 1;
    }
  });

if (require.main === module) {
  program.parseAsync(process.argv);
}

module.exports = program;
