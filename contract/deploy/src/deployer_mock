// =============================================================================
// Cortex Protocol — TypeScript Deployment Client
// Handles fee bumps, retry logic (up to 5 attempts, exponential backoff),
// and ledger confirmation polling.
// =============================================================================

import {
  Keypair,
  Networks,
  SorobanRpc,
  Transaction,
  TransactionBuilder,
  BASE_FEE,
  xdr,
  Operation,
  Contract,
  Address,
  nativeToScVal,
  hash,
} from "@stellar/stellar-sdk";
import * as fs from "fs";
import * as path from "path";
import type {
  DeploymentConfig,
  DeploymentResult,
  DeployedAddresses,
} from "./types.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_RETRY_DELAY_MS = 2_000;
const DEFAULT_MAX_FEE = 1_000_000; // 0.1 XLM
const LEDGER_POLL_INTERVAL_MS = 3_000;
const LEDGER_POLL_MAX_ATTEMPTS = 30;

const DEPLOYED_ADDRESSES_PATH = path.resolve(
  process.cwd(),
  "..",
  "deployed_addresses.json"
);

const WASM_DIR = path.resolve(
  process.cwd(),
  "..",
  "target",
  "wasm32-unknown-unknown",
  "release"
);

// ── Deployer Class ─────────────────────────────────────────────────────────────

export class Deployer {
  private readonly config: Required<DeploymentConfig>;
  private readonly keypair: Keypair;
  private readonly server: SorobanRpc.Server;
  private readonly networkPassphrase: string;

  constructor(config: DeploymentConfig) {
    this.config = {
      maxRetries: DEFAULT_MAX_RETRIES,
      retryDelayMs: DEFAULT_RETRY_DELAY_MS,
      maxFee: DEFAULT_MAX_FEE,
      ...config,
    };

    this.keypair = Keypair.fromSecret(config.secretKey);
    this.server = new SorobanRpc.Server(config.rpcUrl, {
      allowHttp: config.rpcUrl.startsWith("http://"),
    });
    this.networkPassphrase =
      config.network === "mainnet"
        ? Networks.PUBLIC
        : config.network === "futurenet"
        ? Networks.FUTURENET
        : Networks.TESTNET;
  }

  // ── Public: Deploy All ──────────────────────────────────────────────────────

  async deployAll(): Promise<DeployedAddresses> {
    console.log(
      `\n🚀 Starting deployment to ${this.config.network.toUpperCase()}`
    );
    console.log(`   Deployer: ${this.keypair.publicKey()}\n`);

    // Check for existing deployment
    const existing = this.loadExistingAddresses();

    const results: DeployedAddresses = {
      network: this.config.network,
      deployed_at: new Date().toISOString(),
      contracts: {
        marketplace: {
          address:
            existing?.contracts.marketplace.address ||
            (await this.deployContract("marketplace")),
          name: "MarketplaceContract",
        },
        micropayments: {
          address:
            existing?.contracts.micropayments.address ||
            (await this.deployContract("micropayments")),
          name: "MicropaymentsContract",
        },
        agent_registry: {
          address:
            existing?.contracts.agent_registry.address ||
            (await this.deployContract("agent_registry")),
          name: "AgentRegistryContract",
        },
      },
    };

    this.saveAddresses(results);
    this.syncToBackendEnv(results);

    console.log("\n✅ All contracts deployed:");
    for (const [name, info] of Object.entries(results.contracts)) {
      console.log(`   ${name.padEnd(20)} → ${info.address}`);
    }

    return results;
  }

  // ── Deploy Single Contract ──────────────────────────────────────────────────

  async deployContract(contractName: string): Promise<string> {
    const wasmName = contractName.replace(/-/g, "_");
    const wasmPath = path.join(WASM_DIR, `${wasmName}.wasm`);

    if (!fs.existsSync(wasmPath)) {
      throw new Error(
        `WASM not found at ${wasmPath}. Run 'cargo build --target wasm32-unknown-unknown --release' first.`
      );
    }

    const wasmBytes = fs.readFileSync(wasmPath);
    console.log(
      `\n📦 Deploying ${contractName} (${(wasmBytes.length / 1024).toFixed(1)} KB)...`
    );

    return this.withRetry(
      async () => {
        const address = await this.uploadAndDeploy(contractName, wasmBytes);
        console.log(`   ✓ ${contractName} → ${address}`);
        return address;
      },
      contractName,
      this.config.maxRetries
    );
  }

  // ── Upload WASM & Deploy ────────────────────────────────────────────────────

  private async uploadAndDeploy(
    contractName: string,
    wasmBytes: Buffer
  ): Promise<string> {
    const account = await this.server.getAccount(this.keypair.publicKey());

    // Step 1: Upload WASM
    const wasmHash = await this.uploadWasm(account, wasmBytes);
    console.log(
      `   ↑ WASM uploaded (hash: ${wasmHash.toString("hex").slice(0, 16)}...)`
    );

    // Step 2: Create contract instance from WASM hash
    const contractAddress = await this.createContractFromHash(
      account,
      wasmHash
    );

    return contractAddress;
  }

  // ── Upload WASM ─────────────────────────────────────────────────────────────

  private async uploadWasm(
    account: SorobanRpc.Api.GetAccountResponse | Awaited<ReturnType<typeof this.server.getAccount>>,
    wasmBytes: Buffer
  ): Promise<Buffer> {
    const sourceAccount = await this.server.getAccount(this.keypair.publicKey());

    const uploadOp = Operation.uploadContractWasm({ wasm: wasmBytes });

    const tx = new TransactionBuilder(sourceAccount, {
      fee: String(this.config.maxFee),
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(uploadOp)
      .setTimeout(300)
      .build();

    const preparedTx = await this.server.prepareTransaction(tx);
    preparedTx.sign(this.keypair);

    const result = await this.submitAndPoll(preparedTx as Transaction);

    // Extract WASM hash from result
    const wasmHash = hash(wasmBytes);
    return Buffer.from(wasmHash);
  }

  // ── Create Contract Instance ────────────────────────────────────────────────

  private async createContractFromHash(
    _account: unknown,
    wasmHash: Buffer
  ): Promise<string> {
    const sourceAccount = await this.server.getAccount(this.keypair.publicKey());

    const deployerAddress = Address.fromString(this.keypair.publicKey());
    const salt = crypto.getRandomValues(new Uint8Array(32));

    const createOp = Operation.createCustomContract({
      wasmHash,
      address: deployerAddress,
      salt,
    });

    const tx = new TransactionBuilder(sourceAccount, {
      fee: String(this.config.maxFee),
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(createOp)
      .setTimeout(300)
      .build();

    const preparedTx = await this.server.prepareTransaction(tx);
    preparedTx.sign(this.keypair);

    const response = await this.submitAndPoll(preparedTx as Transaction);

    // Extract contract address from return value
    const returnValue = (response as SorobanRpc.Api.GetSuccessfulTransactionResponse).returnValue;
    if (returnValue) {
      const addr = Address.fromScVal(returnValue);
      return addr.toString();
    }

    throw new Error("No return value from contract creation");
  }

  // ── Submit Transaction & Poll for Confirmation ──────────────────────────────

  async submitAndPoll(tx: Transaction): Promise<SorobanRpc.Api.GetTransactionResponse> {
    const sendResult = await this.server.sendTransaction(tx);

    if (sendResult.status === "ERROR") {
      const errCodes = sendResult.errorResult?.result().results() ?? [];
      throw new Error(
        `Transaction submission failed: ${sendResult.errorResult?.toEnvelope().toXDR("base64")}`
      );
    }

    const txHash = sendResult.hash;
    console.log(`   ⏳ TX submitted: ${txHash}`);

    // Poll for ledger confirmation
    for (let attempt = 0; attempt < LEDGER_POLL_MAX_ATTEMPTS; attempt++) {
      await sleep(LEDGER_POLL_INTERVAL_MS);

      const result = await this.server.getTransaction(txHash);

      if (result.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        console.log(`   ✓ Confirmed at ledger ${result.ledger}`);
        return result;
      }

      if (result.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(`Transaction failed: ${JSON.stringify(result)}`);
      }

      // MISSING means still processing
      process.stdout.write(".");
    }

    throw new Error(`Transaction not confirmed after ${LEDGER_POLL_MAX_ATTEMPTS} polls`);
  }

  // ── Fee Bump Wrapper ────────────────────────────────────────────────────────

  async feeBump(innerTx: Transaction): Promise<Transaction> {
    const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
      this.keypair,
      String(this.config.maxFee * 2),
      innerTx,
      this.networkPassphrase
    );
    feeBumpTx.sign(this.keypair);
    return feeBumpTx as unknown as Transaction;
  }

  // ── Retry Logic ─────────────────────────────────────────────────────────────

  private async withRetry<T>(
    fn: () => Promise<T>,
    label: string,
    maxRetries: number
  ): Promise<T> {
    let lastError: Error | undefined;
    let delayMs = this.config.retryDelayMs;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt === maxRetries) break;

        console.warn(
          `   ⚠ ${label} attempt ${attempt}/${maxRetries} failed: ${lastError.message}`
        );
        console.warn(`   Retrying in ${delayMs}ms (exponential backoff)...`);
        await sleep(delayMs);
        delayMs *= 2; // exponential backoff
      }
    }

    throw new Error(
      `All ${maxRetries} attempts failed for ${label}: ${lastError?.message}`
    );
  }

  // ── Address Persistence ─────────────────────────────────────────────────────

  private loadExistingAddresses(): DeployedAddresses | null {
    if (!fs.existsSync(DEPLOYED_ADDRESSES_PATH)) return null;
    try {
      const raw = fs.readFileSync(DEPLOYED_ADDRESSES_PATH, "utf-8");
      return JSON.parse(raw) as DeployedAddresses;
    } catch {
      return null;
    }
  }

  saveAddresses(addresses: DeployedAddresses): void {
    fs.writeFileSync(
      DEPLOYED_ADDRESSES_PATH,
      JSON.stringify(addresses, null, 2)
    );
    console.log(`\n📄 Addresses written to ${DEPLOYED_ADDRESSES_PATH}`);
  }

  private syncToBackendEnv(addresses: DeployedAddresses): void {
    const backendEnvPath = path.resolve(process.cwd(), "..", "..", "backend", ".env");
    const examplePath = path.resolve(process.cwd(), "..", "..", "backend", ".env.example");

    let envContent = "";
    if (fs.existsSync(backendEnvPath)) {
      envContent = fs.readFileSync(backendEnvPath, "utf-8");
    } else if (fs.existsSync(examplePath)) {
      envContent = fs.readFileSync(examplePath, "utf-8");
    }

    const updates: Record<string, string> = {
      MARKETPLACE_CONTRACT_ID: addresses.contracts.marketplace.address,
      MICROPAYMENTS_CONTRACT_ID: addresses.contracts.micropayments.address,
      AGENT_REGISTRY_CONTRACT_ID: addresses.contracts.agent_registry.address,
    };

    for (const [key, value] of Object.entries(updates)) {
      const regex = new RegExp(`^${key}=.*$`, "m");
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, `${key}=${value}`);
      } else {
        envContent += `\n${key}=${value}`;
      }
    }

    fs.writeFileSync(backendEnvPath, envContent);
    console.log(`🔗 backend/.env updated with contract addresses`);
  }

  // ── Getters ─────────────────────────────────────────────────────────────────

  getPublicKey(): string {
    return this.keypair.publicKey();
  }

  getServer(): SorobanRpc.Server {
    return this.server;
  }

  getKeypair(): Keypair {
    return this.keypair;
  }

  getNetworkPassphrase(): string {
    return this.networkPassphrase;
  }

  getConfig(): Required<DeploymentConfig> {
    return this.config;
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
