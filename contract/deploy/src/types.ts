// =============================================================================
// Cortex Protocol — TypeScript Contract Types
// Mirror of Rust contract types for type-safe client interaction
// =============================================================================

// ── Marketplace Types ─────────────────────────────────────────────────────────

export type AssetType =
  | "Prompt"
  | "Workflow"
  | "ReasoningChain"
  | "Dataset"
  | "Evaluator"
  | "MemorySystem"
  | "ModelInstruction"
  | "Tool";

export type LicenseType =
  | "Perpetual"
  | "UsageBased"
  | "Subscription"
  | "OpenSource";

export interface IntelligenceAsset {
  id: bigint;
  owner: string;
  name: string;
  description: string;
  asset_type: AssetType;
  license: LicenseType;
  /** Price in stroops (1 XLM = 10_000_000 stroops) */
  price: bigint;
  usage_count: bigint;
  is_active: boolean;
  created_at: bigint;
}

export interface License {
  asset_id: bigint;
  buyer: string;
  license_type: LicenseType;
  purchased_at: bigint;
  calls_remaining: bigint;
}

// ── Agent Registry Types ──────────────────────────────────────────────────────

export type Capability =
  | "TextGeneration"
  | "CodeGeneration"
  | "Reasoning"
  | "VisionUnderstanding"
  | "AudioProcessing"
  | "DataAnalysis"
  | "WebResearch"
  | "ActionExecution";

export interface Agent {
  id: bigint;
  owner: string;
  name: string;
  description: string;
  capabilities: Capability[];
  /** Reputation score 0–10_000 basis points */
  reputation: number;
  total_transactions: bigint;
  is_active: boolean;
  registered_at: bigint;
}

export interface ReputationVote {
  voter: string;
  agent_id: bigint;
  /** Score 0–100 */
  score: number;
  voted_at: bigint;
}

// ── Micropayments Types ────────────────────────────────────────────────────────

export type StreamStatus = "Active" | "Paused" | "Completed" | "Cancelled";

export interface PaymentStream {
  id: bigint;
  sender: string;
  recipient: string;
  token: string;
  deposit: bigint;
  rate_per_second: bigint;
  start_time: bigint;
  end_time: bigint;
  last_settled: bigint;
  withdrawn: bigint;
  status: StreamStatus;
}

// ── Deployment & Config Types ──────────────────────────────────────────────────

export interface ContractAddresses {
  marketplace: string;
  micropayments: string;
  agent_registry: string;
}

export interface DeployedAddresses {
  network: string;
  deployed_at: string;
  contracts: {
    marketplace: { address: string; name: string };
    micropayments: { address: string; name: string };
    agent_registry: { address: string; name: string };
  };
}

export interface DeploymentConfig {
  network: "testnet" | "mainnet" | "futurenet";
  rpcUrl: string;
  networkPassphrase: string;
  secretKey: string;
  maxRetries?: number;
  retryDelayMs?: number;
  /** Max fee in stroops */
  maxFee?: number;
}

export interface DeploymentResult {
  contractName: string;
  address: string;
  txHash?: string;
  ledger?: number;
  deployedAt: string;
}

export interface InitialisationResult {
  step: string;
  success: boolean;
  txHash?: string;
  data?: unknown;
  error?: string;
}

export interface VerificationCheck {
  label: string;
  expected: string | number | bigint | boolean;
  actual: string | number | bigint | boolean;
  passed: boolean;
}

export interface VerificationReport {
  timestamp: string;
  network: string;
  contracts: ContractAddresses;
  checks: VerificationCheck[];
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  allPassed: boolean;
}

// ── Monitoring Types ───────────────────────────────────────────────────────────

export type ContractHealthStatus = "healthy" | "degraded" | "unreachable" | "unknown";

export interface ContractHealth {
  name: string;
  address: string;
  status: ContractHealthStatus;
  lastChecked: string;
  responseTimeMs: number | null;
  consecutiveFailures: number;
  lastError?: string;
}

export interface SystemHealthStatus {
  network: string;
  timestamp: string;
  overall: ContractHealthStatus;
  contracts: Record<string, ContractHealth>;
}

export interface AlertEvent {
  contractName: string;
  contractAddress: string;
  consecutiveFailures: number;
  lastError: string;
  triggeredAt: string;
  webhookUrl: string;
}
