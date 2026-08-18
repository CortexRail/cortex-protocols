const {
  Contract,
  TransactionBuilder,
  BASE_FEE,
  Address,
  nativeToScVal,
  scValToNative,
  xdr,
} = require("@stellar/stellar-sdk");

const {
  rpcServer,
  networkPassphrase,
  NETWORK,
  CONTRACT_IDS,
} = require("../config/stellar");

// ── Contract error mapping ────────────────────────────────────────────────────
// Mirrors contract/contracts/marketplace/src/errors.rs. Codes are stable and
// safe to surface to clients as inline messages.
const MARKETPLACE_ERRORS = {
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

/**
 * Translate a raw Soroban / RPC error into a client-friendly Error carrying a
 * `status` and (when a contract error code is recognised) a `code`.
 */
function mapContractError(err) {
  const raw =
    typeof err === "string" ? err : err?.message || JSON.stringify(err) || "";
  // Soroban surfaces contract errors as `Error(Contract, #5)` or `#5`.
  const match = raw.match(/#(\d+)/);
  if (match) {
    const code = Number(match[1]);
    const message = MARKETPLACE_ERRORS[code] || `Contract rejected the transaction (error #${code}).`;
    const mapped = new Error(message);
    mapped.status = 400;
    mapped.code = code;
    return mapped;
  }
  const mapped = new Error(raw || "Transaction failed");
  mapped.status = err?.status || 502;
  return mapped;
}

/**
 * Encode a unit-variant Soroban enum (e.g. AssetType::Prompt) as an ScVal.
 * Soroban represents these as a single-element vector holding the variant name.
 */
function enumScVal(variant) {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(variant)]);
}

/**
 * Build and prepare (simulate) an unsigned `list_asset` transaction.
 *
 * @param {object} params
 * @param {string} params.owner        - Lister's Stellar public key (G...).
 * @param {string} params.name
 * @param {string} params.description
 * @param {string} params.assetType    - Matching the on-chain AssetType enum.
 * @param {string} params.licenseType  - Matching the on-chain LicenseType enum.
 * @param {string|number|bigint} params.price - Price in stroops.
 * @returns {Promise<{xdr:string, networkPassphrase:string, network:string}>}
 */
async function buildListAssetTx({ owner, name, description, assetType, licenseType, price }) {
  const contractId = CONTRACT_IDS.marketplace;
  if (!contractId) {
    const err = new Error(
      "Marketplace contract is not configured. Set MARKETPLACE_CONTRACT_ID on the backend."
    );
    err.status = 503;
    throw err;
  }

  // getAccount returns the correct sequence number for a Soroban submission.
  const account = await rpcServer.getAccount(owner);
  const contract = new Contract(contractId);

  const args = [
    Address.fromString(owner).toScVal(),
    nativeToScVal(name, { type: "string" }),
    nativeToScVal(description, { type: "string" }),
    enumScVal(assetType),
    enumScVal(licenseType),
    nativeToScVal(BigInt(price), { type: "i128" }),
  ];

  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    .addOperation(contract.call("list_asset", ...args))
    .setTimeout(120)
    .build();

  let prepared;
  try {
    // prepareTransaction simulates the invocation; contract rejections
    // (e.g. InvalidPrice, InvalidMetadata) surface here, before signing.
    prepared = await rpcServer.prepareTransaction(tx);
  } catch (err) {
    throw mapContractError(err);
  }

  return {
    xdr: prepared.toXDR(),
    networkPassphrase,
    network: NETWORK,
  };
}

/**
 * Submit a Freighter-signed transaction envelope and wait for confirmation.
 *
 * @param {string} signedXdr - Base64 signed transaction envelope.
 * @returns {Promise<{hash:string, assetId:(number|null)}>}
 */
async function submitSignedTx(signedXdr) {
  let tx;
  try {
    tx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
  } catch {
    const err = new Error("Signed transaction is malformed.");
    err.status = 400;
    throw err;
  }

  const sent = await rpcServer.sendTransaction(tx);
  if (sent.status === "ERROR") {
    throw mapContractError(new Error(JSON.stringify(sent.errorResult ?? sent)));
  }

  let result = await rpcServer.getTransaction(sent.hash);
  const maxRetries = 15; // ~22s with 1.5s delay
  let retries = 0;
  while (result.status === "NOT_FOUND" && retries < maxRetries) {
    await new Promise((r) => setTimeout(r, 1500));
    result = await rpcServer.getTransaction(sent.hash);
    retries++;
  }

  if (result.status !== "SUCCESS") {
    throw mapContractError(new Error(`Transaction ${result.status}`));
  }

  let assetId = null;
  if (result.returnValue) {
    const native = scValToNative(result.returnValue);
    assetId = typeof native === "bigint" ? Number(native) : native;
  }

  return { hash: sent.hash, assetId };
}

module.exports = {
  buildListAssetTx,
  submitSignedTx,
  mapContractError,
  enumScVal,
  MARKETPLACE_ERRORS,
};
