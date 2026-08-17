/**
 * DB-backed integration coverage for the two cortex-admin acceptance
 * criteria that can't be proven with mocks:
 *
 *   1. No admin action can bypass the audit trail — every mutating command
 *      is attempted end-to-end and admin_actions is checked afterward.
 *   2. A readonly-role operator key is provably rejected by every mutating
 *      command.
 *
 * Runs against the real Postgres container (see globalSetup.js), invoking
 * the command modules directly rather than mocking their dependencies.
 */

const { Keypair } = require("@stellar/stellar-sdk");
const { query, closePool } = require("../../db/connection");
const { AuthError } = require("../../cli/AuthGate");

const contractCmd = require("../../cli/commands/contract");
const streamCmd = require("../../cli/commands/stream");
const agentCmd = require("../../cli/commands/agent");
const licenseCmd = require("../../cli/commands/license");
const eventsCmd = require("../../cli/commands/events");

const assetRepository = require("../../repositories/assetRepository");
const agentRepository = require("../../repositories/agentRepository");
const streamRepository = require("../../repositories/streamRepository");
const licenseRepository = require("../../repositories/licenseRepository");
const agentBanRepository = require("../../repositories/agentBanRepository");
const eventLogRepository = require("../../repositories/eventLogRepository");

const { truncateAll, buildAsset, buildAgent, buildStream, buildEvent, OWNER_B } = require("../helpers/testDb");

const readonlyKp = Keypair.random();
const moderatorKp = Keypair.random();
const superadminKp = Keypair.random();

const ALLOWLIST = [
  { publicKey: readonlyKp.publicKey(), role: "readonly" },
  { publicKey: moderatorKp.publicKey(), role: "moderator" },
  { publicKey: superadminKp.publicKey(), role: "superadmin" },
];

function asOperator(keypair) {
  process.env.OPERATOR_SECRET_KEY = keypair.secret();
}

beforeEach(async () => {
  await truncateAll();
  process.env.OPERATOR_ALLOWLIST = JSON.stringify(ALLOWLIST);
});

afterEach(() => {
  delete process.env.OPERATOR_ALLOWLIST;
  delete process.env.OPERATOR_SECRET_KEY;
});

afterAll(async () => {
  await closePool();
});

async function adminActionCount() {
  const { rows } = await query("SELECT count(*)::int AS n FROM admin_actions");
  return rows[0].n;
}

async function latestAdminAction() {
  const { rows } = await query("SELECT * FROM admin_actions ORDER BY id DESC LIMIT 1");
  return rows[0];
}

// Every state-changing command, each exercised with real fixtures and a
// real (mocked-nothing) call into the command module.
const MUTATING_COMMANDS = [
  {
    name: "contract pause",
    authorized: superadminKp,
    run: () => contractCmd.pause("marketplace"),
  },
  {
    name: "contract unpause",
    authorized: superadminKp,
    run: () => contractCmd.unpause("marketplace"),
  },
  {
    name: "stream force-settle",
    authorized: moderatorKp,
    setup: async () => {
      const stream = buildStream({ status: "Active" });
      await streamRepository.create(stream);
      return stream.id;
    },
    run: (id) => streamCmd.forceSettle(id),
  },
  {
    name: "agent ban",
    authorized: moderatorKp,
    setup: async () => {
      const agent = buildAgent();
      await agentRepository.create(agent);
      return agent.id;
    },
    run: (id) => agentCmd.ban(id, "abusive behavior"),
  },
  {
    name: "agent unban",
    authorized: moderatorKp,
    setup: async () => {
      const agent = buildAgent();
      await agentRepository.create(agent);
      await agentBanRepository.ban(agent.id, { reason: "prior ban", bannedBy: "GOPERATOR" });
      return agent.id;
    },
    run: (id) => agentCmd.unban(id),
  },
  {
    name: "license revoke",
    authorized: moderatorKp,
    setup: async () => {
      const asset = await assetRepository.create(buildAsset({ licenseType: "UsageBased" }));
      const license = await licenseRepository.create({
        assetId: asset.id,
        buyer: OWNER_B,
        licenseType: "UsageBased",
        pricePaid: 0,
        callsRemaining: 100,
        expiresAt: null,
      });
      return license.id;
    },
    run: (id) => licenseCmd.revoke(id, "policy violation"),
  },
  {
    name: "events replay",
    authorized: superadminKp,
    setup: async () => {
      await eventLogRepository.append(buildEvent({ ledger: 500, txHash: "tx-replay-1" }));
      await eventLogRepository.append(buildEvent({ ledger: 501, txHash: "tx-replay-2" }));
      return { from: 500, to: 501 };
    },
    run: ({ from, to }) => eventsCmd.replay(from, to),
  },
];

describe.each(MUTATING_COMMANDS)("cortex-admin $name", ({ authorized, name, setup, run }) => {
  it("writes an admin_actions row and succeeds when the operator is authorized", async () => {
    const arg = setup ? await setup() : undefined;
    asOperator(authorized);

    const before = await adminActionCount();
    await run(arg);
    const after = await adminActionCount();

    expect(after).toBe(before + 1);
    const action = await latestAdminAction();
    expect(action.command).toBe(name);
    expect(action.status).toBe("success");
    expect(action.operator).toBe(authorized.publicKey());
  });

  it("rejects a readonly-role operator key without writing any admin_actions row", async () => {
    const arg = setup ? await setup() : undefined;
    asOperator(readonlyKp);

    const before = await adminActionCount();
    await expect(run(arg)).rejects.toThrow(AuthError);
    const after = await adminActionCount();

    // Auth happens before AuditTrail runs — a rejected operator never gets
    // the chance to attempt the command, so no row (pending or otherwise)
    // should exist for it.
    expect(after).toBe(before);
  });
});

describe("admin_actions cannot be bypassed across a full command run", () => {
  it("leaves exactly one successful admin_actions row per mutating command attempted", async () => {
    for (const { authorized, run, setup } of MUTATING_COMMANDS) {
      const arg = setup ? await setup() : undefined;
      asOperator(authorized);
      await run(arg);
    }

    const { rows } = await query("SELECT command, status FROM admin_actions ORDER BY id ASC");
    expect(rows).toHaveLength(MUTATING_COMMANDS.length);
    expect(rows.every((r) => r.status === "success")).toBe(true);
    expect(rows.map((r) => r.command)).toEqual(MUTATING_COMMANDS.map((c) => c.name));
  });

  it("still records the attempt when the command itself fails", async () => {
    // force-settling a stream that doesn't exist reaches BatchSettler and
    // throws from inside the audited call — the row must still land.
    asOperator(moderatorKp);
    await expect(streamCmd.forceSettle(999_999)).rejects.toThrow(/not found/);

    const action = await latestAdminAction();
    expect(action.command).toBe("stream force-settle");
    expect(action.status).toBe("error");
    expect(action.error).toMatch(/not found/);
  });
});
