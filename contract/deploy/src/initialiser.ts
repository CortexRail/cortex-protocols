// =============================================================================
// Cortex Protocol — Contract Initialiser
// Calls initialize, list_asset x3, register_agent x2 with realistic sample data
// =============================================================================

import {
  SorobanRpc,
  TransactionBuilder,
  Networks,
  Contract,
  Address,
  nativeToScVal,
  xdr,
  scValToNative,
} from "@stellar/stellar-sdk";
import type { Deployer } from "./deployer.js";
import type {
  DeployedAddresses,
  InitialisationResult,
  AssetType,
  LicenseType,
  Capability,
} from "./types.js";

// ── Sample Data ────────────────────────────────────────────────────────────────

const SAMPLE_ASSETS: Array<{
  name: string;
  description: string;
  asset_type: AssetType;
  license: LicenseType;
  price: bigint; // in stroops
}> = [
  {
    name: "GPT-4 Prompt Optimizer",
    description:
      "A battle-tested system prompt that consistently improves GPT-4 output quality by 40% across reasoning tasks. Includes 50+ calibrated examples.",
    asset_type: "Prompt",
    license: "Perpetual",
    price: 50_000_000n, // 5 XLM
  },
  {
    name: "Automated Code Review Workflow",
    description:
      "Multi-step agent workflow performing security analysis, style checks, and test coverage review on any codebase. Supports Rust, TS, Python.",
    asset_type: "Workflow",
    license: "UsageBased",
    price: 10_000_000n, // 1 XLM per call
  },
  {
    name: "CoT Reasoning Dataset v2",
    description:
      "10,000 curated chain-of-thought examples covering mathematics, logic, and scientific reasoning. CC-BY licensed for commercial use.",
    asset_type: "Dataset",
    license: "OpenSource",
    price: 5_000_000n, // 0.5 XLM
  },
  {
    name: "LLM Evaluator Suite",
    description:
      "Comprehensive evaluation harness for large language models. Benchmarks across MMLU, HumanEval, and custom domain tasks.",
    asset_type: "Evaluator",
    license: "Subscription",
    price: 20_000_000n, // 2 XLM/month
  },
  {
    name: "Vector Memory System",
    description:
      "Persistent, searchable agent memory backed by Pinecone-compatible vector stores. Supports semantic retrieval with context compression.",
    asset_type: "MemorySystem",
    license: "UsageBased",
    price: 1_000_000n, // 0.1 XLM per query
  },
];

const SAMPLE_AGENTS: Array<{
  name: string;
  description: string;
  capabilities: Capability[];
}> = [
  {
    name: "ResearchBot-Alpha",
    description:
      "Autonomous research agent specializing in scientific literature synthesis, fact-checking, and comprehensive report generation across domains.",
    capabilities: ["WebResearch", "TextGeneration", "Reasoning", "DataAnalysis"],
  },
  {
    name: "CodeForge-v1",
    description:
      "Full-stack code generation agent with expertise in Rust, TypeScript, and Solidity. Includes automated testing and security auditing.",
    capabilities: ["CodeGeneration", "Reasoning", "ActionExecution"],
  },
  {
    name: "VisionInsight-Beta",
    description:
      "Multimodal agent combining vision understanding with structured data extraction. Handles documents, diagrams, and UI screenshots.",
    capabilities: ["VisionUnderstanding", "DataAnalysis", "TextGeneration"],
  },
];

// ── Initialiser Class ─────────────────────────────────────────────────────────

export class Initialiser {
  private readonly deployer: Deployer;
  private readonly addresses: DeployedAddresses;
  private readonly results: InitialisationResult[] = [];

  constructor(deployer: Deployer, addresses: DeployedAddresses) {
    this.deployer = deployer;
    this.addresses = addresses;
  }

  // ── Run Full Initialisation ─────────────────────────────────────────────────

  async run(): Promise<InitialisationResult[]> {
    console.log("\n🔧 Starting contract initialisation...\n");

    await this.initializeMarketplace();
    await this.seedAssets();
    await this.registerAgents();

    this.printSummary();
    return this.results;
  }

  // ── Initialize Marketplace ──────────────────────────────────────────────────

  private async initializeMarketplace(): Promise<void> {
    console.log("▶ Initialising Marketplace contract");
    const adminAddress = this.deployer.getPublicKey();

    try {
      const result = await this.invokeContract(
        this.addresses.contracts.marketplace.address,
        "initialize",
        [
          { name: "owner", value: this.addressToScVal(adminAddress) },
        ]
      );

      this.results.push({
        step: "marketplace::initialize",
        success: true,
        txHash: result.txHash,
        data: { admin: adminAddress },
      });
      console.log(`   ✓ Marketplace initialized (admin: ${adminAddress})\n`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      // May already be initialized — treat as warning, not fatal
      if (error.includes("already") || error.includes("AlreadyInitialized")) {
        console.log("   ⚠ Marketplace already initialized, skipping\n");
        this.results.push({
          step: "marketplace::initialize",
          success: true,
          data: { note: "already initialized" },
        });
      } else {
        this.results.push({
          step: "marketplace::initialize",
          success: false,
          error,
        });
        throw new Error(`Marketplace initialization failed: ${error}`);
      }
    }
  }

  // ── Seed Assets ─────────────────────────────────────────────────────────────

  private async seedAssets(): Promise<void> {
    console.log("▶ Seeding sample intelligence assets");
    const ownerAddress = this.deployer.getPublicKey();

    // Seed first 3 assets (as specified in scope)
    const assetsToSeed = SAMPLE_ASSETS.slice(0, 3);

    for (let i = 0; i < assetsToSeed.length; i++) {
      const asset = assetsToSeed[i]!;
      console.log(`   [${i + 1}/3] Listing: ${asset.name}...`);

      try {
        const result = await this.invokeContract(
          this.addresses.contracts.marketplace.address,
          "list_asset",
          [
            { name: "owner",       value: this.addressToScVal(ownerAddress) },
            { name: "name",        value: this.stringToScVal(asset.name) },
            { name: "description", value: this.stringToScVal(asset.description) },
            { name: "asset_type",  value: this.enumToScVal(asset.asset_type) },
            { name: "license",     value: this.enumToScVal(asset.license) },
            { name: "price",       value: this.i128ToScVal(asset.price) },
          ]
        );

        this.results.push({
          step: `marketplace::list_asset[${i + 1}]`,
          success: true,
          txHash: result.txHash,
          data: { name: asset.name, license: asset.license, price: asset.price.toString() },
        });
        console.log(`   ✓ Asset ${i + 1} listed (${asset.license}, ${Number(asset.price) / 1e7} XLM)`);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        this.results.push({
          step: `marketplace::list_asset[${i + 1}]`,
          success: false,
          error,
          data: { name: asset.name },
        });
        console.error(`   ✗ Failed to list asset ${i + 1}: ${error}`);
      }
    }
    console.log();
  }

  // ── Register Agents ─────────────────────────────────────────────────────────

  private async registerAgents(): Promise<void> {
    console.log("▶ Registering agents in Agent Registry");
    const ownerAddress = this.deployer.getPublicKey();

    // Register first 2 agents (as specified in scope)
    const agentsToRegister = SAMPLE_AGENTS.slice(0, 2);

    for (let i = 0; i < agentsToRegister.length; i++) {
      const agent = agentsToRegister[i]!;
      console.log(`   [${i + 1}/2] Registering: ${agent.name}...`);

      try {
        const result = await this.invokeContract(
          this.addresses.contracts.agent_registry.address,
          "register_agent",
          [
            { name: "owner",        value: this.addressToScVal(ownerAddress) },
            { name: "name",         value: this.stringToScVal(agent.name) },
            { name: "description",  value: this.stringToScVal(agent.description) },
            { name: "capabilities", value: this.capabilitiesToScVal(agent.capabilities) },
          ]
        );

        this.results.push({
          step: `agent_registry::register_agent[${i + 1}]`,
          success: true,
          txHash: result.txHash,
          data: { name: agent.name, capabilities: agent.capabilities },
        });
        console.log(`   ✓ Agent ${i + 1} registered (${agent.capabilities.join(", ")})`);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        this.results.push({
          step: `agent_registry::register_agent[${i + 1}]`,
          success: false,
          error,
          data: { name: agent.name },
        });
        console.error(`   ✗ Failed to register agent ${i + 1}: ${error}`);
      }
    }
    console.log();
  }

  // ── Contract Invocation ─────────────────────────────────────────────────────

  private async invokeContract(
    contractId: string,
    functionName: string,
    args: Array<{ name: string; value: xdr.ScVal }>
  ): Promise<{ txHash: string; result?: unknown }> {
    const contract = new Contract(contractId);
    const sourceAccount = await this.deployer
      .getServer()
      .getAccount(this.deployer.getPublicKey());

    const operation = contract.call(
      functionName,
      ...args.map((a) => a.value)
    );

    const server = this.deployer.getServer();
    const networkPassphrase = this.deployer.getNetworkPassphrase();

    const tx = new TransactionBuilder(sourceAccount, {
      fee: String(this.deployer.getConfig().maxFee),
      networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(300)
      .build();

    const preparedTx = await server.prepareTransaction(tx);
    preparedTx.sign(this.deployer.getKeypair());

    const response = await this.deployer.submitAndPoll(
      preparedTx as ReturnType<typeof preparedTx.sign extends never ? never : any>
    );

    const txHash = (response as any).hash ?? "";
    const returnValue = (response as SorobanRpc.Api.GetSuccessfulTransactionResponse)
      .returnValue;

    return {
      txHash,
      result: returnValue ? scValToNative(returnValue) : undefined,
    };
  }

  // ── ScVal Helpers ───────────────────────────────────────────────────────────

  private addressToScVal(address: string): xdr.ScVal {
    return Address.fromString(address).toScVal();
  }

  private stringToScVal(value: string): xdr.ScVal {
    return xdr.ScVal.scvString(Buffer.from(value, "utf-8"));
  }

  private i128ToScVal(value: bigint): xdr.ScVal {
    return nativeToScVal(value, { type: "i128" });
  }

  private enumToScVal(variant: string): xdr.ScVal {
    return xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol(variant),
      xdr.ScVal.scvVoid(),
    ]);
  }

  private capabilitiesToScVal(capabilities: Capability[]): xdr.ScVal {
    return xdr.ScVal.scvVec(
      capabilities.map((cap) =>
        xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(cap), xdr.ScVal.scvVoid()])
      )
    );
  }

  // ── Summary ─────────────────────────────────────────────────────────────────

  private printSummary(): void {
    const passed = this.results.filter((r) => r.success).length;
    const failed = this.results.filter((r) => !r.success).length;

    console.log("─".repeat(60));
    console.log(`Initialisation complete: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
      console.log("\nFailed steps:");
      for (const r of this.results.filter((r) => !r.success)) {
        console.log(`  ✗ ${r.step}: ${r.error}`);
      }
    }
  }

  getResults(): InitialisationResult[] {
    return this.results;
  }
}
