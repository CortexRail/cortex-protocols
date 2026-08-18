// Mirrors the on-chain enums (contract/contracts/marketplace/src/lib.rs) and the
// backend validation rules (backend/src/services/assetService.js).

export const ASSET_TYPES = [
  "Prompt",
  "Workflow",
  "ReasoningChain",
  "Dataset",
  "Evaluator",
  "MemorySystem",
  "ModelInstruction",
  "Tool",
] as const;

export const LICENSE_TYPES = [
  "Perpetual",
  "UsageBased",
  "Subscription",
  "OpenSource",
] as const;

export type AssetType = (typeof ASSET_TYPES)[number];
export type LicenseType = (typeof LICENSE_TYPES)[number];

// Human-friendly labels for the dropdowns.
export const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  Prompt: "Prompt",
  Workflow: "Workflow",
  ReasoningChain: "Reasoning Chain",
  Dataset: "Dataset",
  Evaluator: "Evaluator",
  MemorySystem: "Memory System",
  ModelInstruction: "Model Instruction",
  Tool: "Tool",
};

export const LICENSE_TYPE_LABELS: Record<LicenseType, string> = {
  Perpetual: "Perpetual — one-time purchase",
  UsageBased: "Usage-Based — pay per call",
  Subscription: "Subscription — time-bound",
  OpenSource: "Open Source — attribution required",
};

// Field length limits — must match the backend express-validator rules.
export const NAME_MAX = 200;
export const DESCRIPTION_MAX = 2000;

// 1 XLM = 10,000,000 stroops.
export const STROOPS_PER_XLM = 10_000_000n;

// Stellar network the app targets, surfaced to the user and checked against
// the wallet's active network.
export const STELLAR_NETWORK = (
  process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? "testnet"
).toUpperCase();

export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

// Human-friendly label for a Freighter network name.
export function networkLabel(network: string | undefined | null): string {
  switch ((network || "").toUpperCase()) {
    case "PUBLIC":
      return "Mainnet";
    case "TESTNET":
      return "Testnet";
    case "FUTURENET":
      return "Futurenet";
    default:
      return network || "Unknown";
  }
}

// Label for the app's target network (STELLAR_NETWORK is upper-cased).
export const TARGET_NETWORK_LABEL = networkLabel(STELLAR_NETWORK);

// Mirrors contract/contracts/marketplace/src/errors.rs so a raw contract code
// can be shown inline if the backend ever returns one it didn't map itself.
export const MARKETPLACE_ERROR_MESSAGES: Record<number, string> = {
  1: "You are not the owner of this asset.",
  2: "Asset does not exist.",
  3: "Asset is inactive or unavailable.",
  4: "You cannot purchase your own asset.",
  5: "Price must be greater than zero.",
  6: "The marketplace has reached its asset limit.",
  7: "You already hold a license for this asset.",
  8: "You are not authorized to perform this action.",
  9: "Asset metadata is missing or invalid.",
  10: "Payment amount does not match the asset price.",
  11: "Asset has already been purchased or licensed.",
  12: "This asset is already listed.",
  13: "Asset is not currently listed.",
  14: "Listing cannot be modified in its current state.",
  15: "An arithmetic error occurred.",
};
