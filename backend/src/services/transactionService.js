/**
 * transactionService.js
 *
 * Fetches paginated Horizon transactions for a given Stellar public key,
 * filters to only those that touch a known contract address, parses each
 * operation into a human-readable summary, and caches results to avoid
 * hammering the Horizon API.
 */

const { horizonServer, CONTRACT_IDS } = require("../config/stellar");

// ── Cache ─────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5_000; // 5-second TTL

/**
 * Simple in-memory TTL cache.
 * Key: string  →  Value: { data, expiresAt }
 */
const _cache = new Map();

function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _cache.delete(key);
    return null;
  }
  return entry.data;
}

function cacheSet(key, data) {
  _cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Exposed for tests that need to wipe the cache between cases. */
function cacheClear() {
  _cache.clear();
}

// ── Contract address set ──────────────────────────────────────────────────────

/**
 * Returns a Set of all known contract addresses (lower-cased for comparison).
 * Filters out empty strings so unconfigured env vars are ignored.
 */
function knownContractAddresses() {
  return new Set(
    Object.values(CONTRACT_IDS)
      .filter(Boolean)
      .map((a) => a.toLowerCase())
  );
}

// ── Operation parsing ─────────────────────────────────────────────────────────

/**
 * Extract a human-readable summary from a single Horizon operation record.
 *
 * Horizon operation types relevant to Soroban / contract interactions:
 *   - invoke_host_function  (Soroban contract calls)
 *   - payment
 *   - path_payment_strict_send / path_payment_strict_receive
 *   - create_account
 *   - change_trust
 *
 * We inspect the function name when available to build a richer label.
 */
function parseOperationSummary(op, contractAddresses) {
  const type = op.type || "unknown";

  switch (type) {
    case "invoke_host_function": {
      const fn = (op.function || "").toLowerCase();
      const contractId = (op.contract_id || "").toLowerCase();

      if (fn === "list_asset" || fn === "listasset") {
        return "Listed a new intelligence asset";
      }
      if (fn === "delist_asset" || fn === "delistasset") {
        return "Delisted an intelligence asset";
      }
      if (fn === "purchase_license" || fn === "purchaselicense") {
        // Try to extract asset id from the raw args if present
        const assetId = op.parameters?.find(
          (p) => p.name === "asset_id" || p.name === "assetId"
        )?.value;
        return assetId
          ? `Purchased license for asset #${assetId}`
          : "Purchased a license";
      }
      if (fn === "update_price" || fn === "updateprice") {
        return "Updated asset price";
      }
      if (fn === "open_stream" || fn === "openstream") {
        return "Opened a micropayment stream";
      }
      if (fn === "withdraw") {
        return "Withdrew from a micropayment stream";
      }
      if (fn === "cancel_stream" || fn === "cancelstream") {
        return "Cancelled a micropayment stream";
      }
      if (fn === "register_agent" || fn === "registeragent") {
        return "Registered an agent";
      }
      if (fn === "record_transaction" || fn === "recordtransaction") {
        return "Recorded an agent transaction";
      }

      // Generic contract call label
      if (contractAddresses.has(contractId)) {
        return fn ? `Called contract function: ${op.function}` : "Invoked contract";
      }

      return "Invoked a smart contract";
    }

    case "payment": {
      const asset =
        op.asset_type === "native"
          ? "XLM"
          : `${op.asset_code}/${op.asset_issuer?.slice(0, 6)}…`;
      const dir = op.to ? `to ${op.to.slice(0, 8)}…` : "";
      return `Payment of ${op.amount} ${asset} ${dir}`.trim();
    }

    case "path_payment_strict_send":
    case "path_payment_strict_receive": {
      const srcAsset = op.source_asset_type === "native" ? "XLM" : op.source_asset_code;
      const destAsset = op.asset_type === "native" ? "XLM" : op.asset_code;
      return `Path payment: ${op.source_amount} ${srcAsset} → ${op.amount} ${destAsset}`;
    }

    case "create_account":
      return `Created account ${op.account?.slice(0, 8)}…`;

    case "change_trust":
      return `Changed trust for ${op.asset_code || "asset"}`;

    default:
      return `${type.replace(/_/g, " ")} operation`;
  }
}

// ── Transaction filtering ─────────────────────────────────────────────────────

/**
 * Return true if the transaction or any of its embedded operations involves
 * a known contract address.
 *
 * Horizon exposes contract_ids at the transaction level for Soroban txns.
 * We also fall back to inspecting individual operation.contract_id fields.
 */
function involvesKnownContract(tx, ops, contractAddresses) {
  if (contractAddresses.size === 0) return true; // no filter configured → show all

  // Horizon Soroban txns expose a `soroban_meta` with contract IDs
  const txContractIds = (tx.contract_ids || []).map((c) => c.toLowerCase());
  if (txContractIds.some((c) => contractAddresses.has(c))) return true;

  // Check each operation's contract_id
  return ops.some((op) => {
    const cid = (op.contract_id || "").toLowerCase();
    return cid && contractAddresses.has(cid);
  });
}

// ── Main fetch function ───────────────────────────────────────────────────────

/**
 * Fetch paginated, filtered, and annotated transactions for a public key.
 *
 * @param {string} publicKey       - Stellar G-address
 * @param {object} [options]
 * @param {number} [options.page]  - 1-based page number (default: 1)
 * @param {number} [options.limit] - Records per page, 1–200 (default: 20)
 * @param {string} [options.cursor] - Horizon paging token (overrides page)
 * @returns {Promise<{ data: object[], meta: object }>}
 */
async function getAccountTransactions(publicKey, { page = 1, limit = 20, cursor } = {}) {
  const clampedLimit = Math.min(Math.max(Number(limit) || 20, 1), 200);
  const cacheKey = `txns:${publicKey}:p${page}:l${clampedLimit}:c${cursor || ""}`;

  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const contractAddresses = knownContractAddresses();

  // ── Horizon call ───────────────────────────────────────────────────────────
  // We request more than `limit` because some may be filtered out.
  // Fetch up to 200 at once (Horizon cap) to fill the requested page.
  const horizonLimit = Math.min(clampedLimit * 5, 200);

  let builder = horizonServer
    .transactions()
    .forAccount(publicKey)
    .limit(horizonLimit)
    .order("desc")
    .includeFailed(false);

  if (cursor) {
    builder = builder.cursor(cursor);
  }

  const txPage = await builder.call();
  const records = txPage.records || [];

  // ── Fetch operations for each transaction in parallel ─────────────────────
  const withOps = await Promise.all(
    records.map(async (tx) => {
      try {
        const opsPage = await horizonServer
          .operations()
          .forTransaction(tx.hash)
          .limit(50)
          .call();
        return { tx, ops: opsPage.records || [] };
      } catch {
        return { tx, ops: [] };
      }
    })
  );

  // ── Filter to contract-related transactions ────────────────────────────────
  const filtered = withOps.filter(({ tx, ops }) =>
    involvesKnownContract(tx, ops, contractAddresses)
  );

  // ── Apply page-level slicing ───────────────────────────────────────────────
  const pageIndex = Math.max(Number(page) || 1, 1);
  const offset = (pageIndex - 1) * clampedLimit;
  const slice = filtered.slice(offset, offset + clampedLimit);

  // ── Shape the response ─────────────────────────────────────────────────────
  const data = slice.map(({ tx, ops }) => {
    const summaries = ops.map((op) => parseOperationSummary(op, contractAddresses));
    const primarySummary =
      summaries.find((s) => !s.startsWith("Payment") && !s.includes("operation")) ||
      summaries[0] ||
      "Transaction";

    return {
      hash: tx.hash,
      ledger: tx.ledger_attr,
      createdAt: tx.created_at,
      successful: tx.successful,
      feeCharged: tx.fee_charged,
      operationCount: tx.operation_count,
      summary: primarySummary,
      operations: ops.map((op) => ({
        id: op.id,
        type: op.type,
        summary: parseOperationSummary(op, contractAddresses),
        sourceAccount: op.source_account,
        ...(op.contract_id ? { contractId: op.contract_id } : {}),
      })),
      pagingToken: tx.paging_token,
    };
  });

  const nextCursor =
    slice.length === clampedLimit
      ? slice[slice.length - 1]?.tx?.paging_token
      : null;

  const result = {
    data,
    meta: {
      page: pageIndex,
      limit: clampedLimit,
      count: data.length,
      hasMore: nextCursor !== null,
      nextCursor,
    },
  };

  cacheSet(cacheKey, result);
  return result;
}

module.exports = { getAccountTransactions, cacheClear, parseOperationSummary };
