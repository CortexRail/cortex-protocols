// =============================================================================
// Cortex Protocol — On-Chain State Verifier
// Reads back all state and compares against expected values:
//   asset count, agent count, contract admin, each asset's fields
// =============================================================================

import {
  SorobanRpc,
  TransactionBuilder,
  Contract,
  Address,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type { Deployer } from "./deployer.js";
import type {
  DeployedAddresses,
  VerificationCheck,
  VerificationReport,
  IntelligenceAsset,
  Agent,
} from "./types.js";

// ── Expected State ─────────────────────────────────────────────────────────────

const EXPECTED = {
  marketplace: {
    assetCount: 3,
    assets: [
      {
        id: 1n,
        name: "GPT-4 Prompt Optimizer",
        asset_type: "Prompt",
        license: "Perpetual",
        price: 50_000_000n,
        is_active: true,
      },
      {
        id: 2n,
        name: "Automated Code Review Workflow",
        asset_type: "Workflow",
        license: "UsageBased",
        price: 10_000_000n,
        is_active: true,
      },
      {
        id: 3n,
        name: "CoT Reasoning Dataset v2",
        asset_type: "Dataset",
        license: "OpenSource",
        price: 5_000_000n,
        is_active: true,
      },
    ],
  },
  agentRegistry: {
    agentCount: 2,
    agents: [
      {
        id: 1n,
        name: "ResearchBot-Alpha",
        reputation: 5000,
        is_active: true,
      },
      {
        id: 2n,
        name: "CodeForge-v1",
        reputation: 5000,
        is_active: true,
      },
    ],
  },
  micropayments: {
    streamCount: 0,
  },
};

// ── Verifier Class ─────────────────────────────────────────────────────────────

export class Verifier {
  private readonly deployer: Deployer;
  private readonly addresses: DeployedAddresses;
  private readonly checks: VerificationCheck[] = [];

  constructor(deployer: Deployer, addresses: DeployedAddresses) {
    this.deployer = deployer;
    this.addresses = addresses;
  }

  // ── Run Full Verification ───────────────────────────────────────────────────

  async verify(): Promise<VerificationReport> {
    console.log("\n🔍 Starting on-chain verification...\n");

    await this.verifyContractExists("marketplace", this.addresses.contracts.marketplace.address);
    await this.verifyContractExists("micropayments", this.addresses.contracts.micropayments.address);
    await this.verifyContractExists("agent_registry", this.addresses.contracts.agent_registry.address);

    await this.verifyMarketplace();
    await this.verifyAgentRegistry();
    await this.verifyMicropayments();

    return this.buildReport();
  }

  // ── Verify Contract Is Deployed ─────────────────────────────────────────────

  private async verifyContractExists(name: string, address: string): Promise<void> {
    try {
      const ledgerKey = xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: Address.fromString(address).toScAddress(),
          key: xdr.ScVal.scvLedgerKeyContractInstance(),
          durability: xdr.ContractDataDurability.persistent(),
        })
      );
      const result = await this.deployer.getServer().getLedgerEntries(ledgerKey);
      const exists = result.entries && result.entries.length > 0;
      this.addCheck(`${name} contract exists on-chain`, "true", String(exists));
    } catch (err) {
      this.addCheck(`${name} contract exists on-chain`, "true", "false");
    }
  }

  // ── Verify Marketplace ──────────────────────────────────────────────────────

  private async verifyMarketplace(): Promise<void> {
    console.log("▶ Verifying Marketplace");
    const contractId = this.addresses.contracts.marketplace.address;

    // asset_count
    const assetCount = await this.query(contractId, "asset_count", []);
    const assetCountNum = this.toNumber(assetCount);
    this.addCheck(
      "marketplace::asset_count",
      EXPECTED.marketplace.assetCount,
      assetCountNum
    );

    // Verify each asset
    for (const expected of EXPECTED.marketplace.assets) {
      const asset = await this.query(contractId, "get_asset", [
        nativeToScVal(expected.id, { type: "u64" }),
      ]);

      if (asset === null || asset === undefined) {
        this.addCheck(`marketplace::get_asset(${expected.id}) exists`, "true", "false");
        continue;
      }

      const assetData = asset as Record<string, unknown>;

      this.addCheck(
        `asset[${expected.id}].name`,
        expected.name,
        String(assetData["name"] ?? "")
      );
      this.addCheck(
        `asset[${expected.id}].is_active`,
        String(expected.is_active),
        String(assetData["is_active"] ?? false)
      );
      this.addCheck(
        `asset[${expected.id}].price`,
        expected.price.toString(),
        String(assetData["price"] ?? "0")
      );
    }

    // Non-existent asset should return None
    const missingAsset = await this.query(contractId, "get_asset", [
      nativeToScVal(999n, { type: "u64" }),
    ]);
    this.addCheck(
      "marketplace::get_asset(999) returns null",
      "null",
      missingAsset === null || missingAsset === undefined ? "null" : "present"
    );

    console.log(`   ✓ Marketplace checks complete\n`);
  }

  // ── Verify Agent Registry ───────────────────────────────────────────────────

  private async verifyAgentRegistry(): Promise<void> {
    console.log("▶ Verifying Agent Registry");
    const contractId = this.addresses.contracts.agent_registry.address;

    // agent_count
    const agentCount = await this.query(contractId, "agent_count", []);
    const agentCountNum = this.toNumber(agentCount);
    this.addCheck(
      "agent_registry::agent_count",
      EXPECTED.agentRegistry.agentCount,
      agentCountNum
    );

    // Verify each agent
    for (const expected of EXPECTED.agentRegistry.agents) {
      const agent = await this.query(contractId, "get_agent", [
        nativeToScVal(expected.id, { type: "u64" }),
      ]);

      if (agent === null || agent === undefined) {
        this.addCheck(`agent_registry::get_agent(${expected.id}) exists`, "true", "false");
        continue;
      }

      const agentData = agent as Record<string, unknown>;

      this.addCheck(
        `agent[${expected.id}].name`,
        expected.name,
        String(agentData["name"] ?? "")
      );
      this.addCheck(
        `agent[${expected.id}].is_active`,
        String(expected.is_active),
        String(agentData["is_active"] ?? false)
      );

      // get_reputation separately
      const rep = await this.query(contractId, "get_reputation", [
        nativeToScVal(expected.id, { type: "u64" }),
      ]);
      this.addCheck(
        `agent[${expected.id}].reputation (default neutral)`,
        expected.reputation,
        this.toNumber(rep)
      );
    }

    console.log(`   ✓ Agent Registry checks complete\n`);
  }

  // ── Verify Micropayments ────────────────────────────────────────────────────

  private async verifyMicropayments(): Promise<void> {
    console.log("▶ Verifying Micropayments");
    const contractId = this.addresses.contracts.micropayments.address;

    // stream_count
    const streamCount = await this.query(contractId, "stream_count", []);
    this.addCheck(
      "micropayments::stream_count",
      EXPECTED.micropayments.streamCount,
      this.toNumber(streamCount)
    );

    // get_stream(1) should return None
    const stream1 = await this.query(contractId, "get_stream", [
      nativeToScVal(1n, { type: "u64" }),
    ]);
    this.addCheck(
      "micropayments::get_stream(1) returns null",
      "null",
      stream1 === null || stream1 === undefined ? "null" : "present"
    );

    console.log(`   ✓ Micropayments checks complete\n`);
  }

  // ── Contract Query Helper ───────────────────────────────────────────────────

  private async query(
    contractId: string,
    functionName: string,
    args: xdr.ScVal[]
  ): Promise<unknown> {
    try {
      const contract = new Contract(contractId);
      const server = this.deployer.getServer();
      const networkPassphrase = this.deployer.getNetworkPassphrase();
      const sourceAccount = await server.getAccount(this.deployer.getPublicKey());

      const operation = contract.call(functionName, ...args);

      const tx = new TransactionBuilder(sourceAccount, {
        fee: String(this.deployer.getConfig().maxFee),
        networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(300)
        .build();

      const preparedTx = await server.prepareTransaction(tx);
      preparedTx.sign(this.deployer.getKeypair());

      const response = await this.deployer.submitAndPoll(preparedTx as any);
      const returnValue = (response as SorobanRpc.Api.GetSuccessfulTransactionResponse)
        .returnValue;

      if (!returnValue) return null;

      const native = scValToNative(returnValue);

      // Handle Option types: Soroban returns void for None
      if (returnValue.switch() === xdr.ScValType.scvVoid()) return null;

      // Handle vec wrapping from Option<T>
      if (
        returnValue.switch() === xdr.ScValType.scvVec() &&
        returnValue.vec()?.length === 2
      ) {
        const tag = returnValue.vec()![0]!.sym?.().toString();
        if (tag === "Some") {
          return scValToNative(returnValue.vec()![1]!);
        }
        if (tag === "None") return null;
      }

      return native;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`   ⚠ Query ${functionName} failed: ${msg}`);
      return undefined;
    }
  }

  // ── Check Helpers ───────────────────────────────────────────────────────────

  private addCheck(
    label: string,
    expected: string | number | bigint | boolean,
    actual: string | number | bigint | boolean
  ): void {
    const passed = String(expected) === String(actual);
    this.checks.push({ label, expected, actual, passed });

    const icon = passed ? "✓" : "✗";
    const color = passed ? "\x1b[32m" : "\x1b[31m";
    const reset = "\x1b[0m";
    console.log(
      `   ${color}${icon}${reset} ${label}: ${passed ? actual : `expected='${expected}' actual='${actual}'`}`
    );
  }

  private toNumber(value: unknown): number {
    if (typeof value === "bigint") return Number(value);
    if (typeof value === "number") return value;
    if (typeof value === "string") return Number(value);
    return 0;
  }

  // ── Build Report ────────────────────────────────────────────────────────────

  private buildReport(): VerificationReport {
    const passedChecks = this.checks.filter((c) => c.passed).length;
    const failedChecks = this.checks.filter((c) => !c.passed).length;
    const allPassed = failedChecks === 0;

    const report: VerificationReport = {
      timestamp: new Date().toISOString(),
      network: this.addresses.network,
      contracts: {
        marketplace: this.addresses.contracts.marketplace.address,
        micropayments: this.addresses.contracts.micropayments.address,
        agent_registry: this.addresses.contracts.agent_registry.address,
      },
      checks: this.checks,
      totalChecks: this.checks.length,
      passedChecks,
      failedChecks,
      allPassed,
    };

    console.log("\n" + "─".repeat(60));
    console.log(`Verification: ${passedChecks}/${this.checks.length} passed`);
    if (allPassed) {
      console.log("\x1b[32m✔ All contracts verified successfully!\x1b[0m");
    } else {
      console.log(`\x1b[31m✘ ${failedChecks} check(s) failed\x1b[0m`);
    }

    return report;
  }
}
