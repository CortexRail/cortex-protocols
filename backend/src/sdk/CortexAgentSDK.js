const {
  Contract,
  TransactionBuilder,
  BASE_FEE,
  Address,
  nativeToScVal,
  rpc,
  scValToNative,
} = require("@stellar/stellar-sdk");
const SorobanRpc = rpc || require("@stellar/stellar-sdk").SorobanRpc;
const { logger } = require("../utils/logger");
const AttestationBuilder = require("../attestation/AttestationBuilder");
const AttestationVerifier = require("../attestation/AttestationVerifier");
const MerkleBatchBuilder = require("../attestation/MerkleBatchBuilder");
const { toFixedBuffer } = require("../attestation/canonical");

class CortexAgentSDK {
  /**
   * @param {object} config
   * @param {string} config.backendUrl - URL of the Cortex backend (e.g. http://localhost:4000)
   * @param {string} [config.rpcUrl] - Soroban RPC URL (defaults to testnet)
   * @param {string} [config.horizonUrl] - Horizon URL (defaults to testnet)
   * @param {string} [config.networkPassphrase] - Stellar network passphrase
   * @param {string} [config.micropaymentsContractId] - Deployed micropayments contract address
   * @param {string} [config.tokenAddress] - Token asset address (default 'native' for XLM)
   * @param {Keypair} config.buyerKeypair - Buyer keypair for signing transactions
   * @param {Keypair} [config.sellerKeypair] - Seller keypair, required only for
   *   the seller-side `attestCall`. A seller's G... address is an Ed25519
   *   public key, so the key that receives payment is also the one that signs
   *   attestations; pass a different keypair only if you have registered it
   *   on-chain with register_attestation_key.
   */
  constructor(config) {
    if (!config.backendUrl) {
      throw new Error("backendUrl is required");
    }
    if (!config.buyerKeypair) {
      throw new Error("buyerKeypair is required");
    }

    this.backendUrl = config.backendUrl.replace(/\/$/, "");
    this.buyerKeypair = config.buyerKeypair;
    this.rpcUrl = config.rpcUrl || "https://soroban-testnet.stellar.org";
    this.horizonUrl = config.horizonUrl || "https://horizon-testnet.stellar.org";
    this.networkPassphrase = config.networkPassphrase || "Test SDF Network ; September 2015";
    this.micropaymentsContractId = config.micropaymentsContractId;
    this.tokenAddress = config.tokenAddress || "CDLZFC3SYJYDZT7K6AOFHG23NFR7EDLI226OJZ5U3XEE2FEUA7HJTZUA"; // default testnet native token or mock

    // Lazy load server instances
    this.rpcServer = new SorobanRpc.Server(this.rpcUrl);

    // Seller-side signing is optional: a buyer-only agent never needs a key it
    // does not have, so the builder is only constructed when one is supplied.
    this.sellerKeypair = config.sellerKeypair || null;
    this._attestationBuilder = this.sellerKeypair
      ? new AttestationBuilder({ signer: this.sellerKeypair })
      : null;

    // Verification is stateless and needs no key, so every agent gets one.
    this._attestationVerifier = new AttestationVerifier();
  }

  /**
   * Helper to make REST requests to the backend.
   */
  async _request(method, path, body = null, headers = {}) {
    const url = `${this.backendUrl}${path}`;
    const options = {
      method,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const res = await fetch(url, options);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const err = new Error(data.error || `HTTP error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  /**
   * Discover assets by type or capability.
   */
  async discover(filters = {}) {
    const params = new URLSearchParams();
    if (filters.assetType) params.append("assetType", filters.assetType);
    if (filters.licenseType) params.append("licenseType", filters.licenseType);
    if (filters.search) params.append("search", filters.search);
    if (filters.limit) params.append("limit", filters.limit);

    const queryStr = params.toString() ? `?${params.toString()}` : "";
    return this._request("GET", `/api/v1/assets${queryStr}`);
  }

  /**
   * Fetches a signed price quote for an asset.
   */
  async getQuote(assetId) {
    return this._request("POST", "/api/v1/protocol/quote", {
      publicKey: this.buyerKeypair.publicKey(),
      assetId: Number(assetId),
    });
  }

  /**
   * Open payment stream end-to-end: handshake, negotiate rate, open on-chain, and register token.
   */
  async openStream(assetId, depositXlm, durationHours) {
    const buyerPubkey = this.buyerKeypair.publicKey();

    // 1. Handshake to initiate session and retrieve initial quote
    const handshake = await this._request("POST", "/api/v1/protocol/handshake", {
      publicKey: buyerPubkey,
      assetId: Number(assetId),
    });

    const quote = handshake.quote;
    const initialPrice = handshake.price;

    // 2. Propose a rate (negotiate rate). We propose the quote price
    const negotiation = await this._request("POST", "/api/v1/protocol/negotiate", {
      buyer: buyerPubkey,
      assetId: Number(assetId),
      proposedRate: initialPrice,
      quote,
    });

    if (negotiation.status !== "Agreed") {
      throw new Error(`Rate negotiation failed: server replied with status ${negotiation.status}`);
    }

    const agreedRate = negotiation.rate; // price per call in stroops

    // Calculate duration and on-chain flow rate
    const durationSecs = durationHours * 3600;
    const depositStroops = Math.floor(depositXlm * 10_000_000);
    const ratePerSecond = Math.max(1, Math.floor(depositStroops / durationSecs));

    let streamId;

    // Determine recipient/seller key
    const assetDetail = await this._request("GET", `/api/v1/assets/${assetId}`);
    const recipientPubkey = assetDetail.owner;

    // 3. Open stream on-chain
    try {
      streamId = await this._openStreamOnChain(
        recipientPubkey,
        depositStroops,
        ratePerSecond,
        durationSecs
      );
    } catch (err) {
      logger.warn("[CortexAgentSDK] On-chain stream opening failed, falling back to mock registration:", err.message);
      // Fallback: Generate a random stream ID in mock/offline mode
      streamId = Math.floor(Math.random() * 1_000_000) + 1;
    }

    // 4. Register opened stream with the server and retrieve stream token JWT
    const register = await this._request("POST", "/api/v1/protocol/stream/open", {
      streamId,
      agreedRate,
      buyer: buyerPubkey,
      assetId: Number(assetId),
    });

    return {
      streamId,
      streamToken: register.streamToken,
      stream: register.stream,
    };
  }

  /**
   * Internal helper to make Soroban RPC call to open stream on-chain.
   */
  async _openStreamOnChain(recipient, deposit, ratePerSecond, durationSecs) {
    const contractId = this.micropaymentsContractId;
    if (!contractId) {
      throw new Error("micropaymentsContractId is not configured on SDK client");
    }

    // Load account sequence
    const buyerAddr = this.buyerKeypair.publicKey();
    const res = await fetch(`${this.horizonUrl}/accounts/${buyerAddr}`);
    if (!res.ok) throw new Error("Horizon account load failed");
    const accountData = await res.json();

    const account = new TransactionBuilder.fromXDR(
      new TransactionBuilder(
        {
          sequence: accountData.sequence,
          accountId: buyerAddr,
        },
        { fee: BASE_FEE, networkPassphrase: this.networkPassphrase }
      )
        .addOperation(
          new Contract(contractId).call(
            "open_stream",
            Address.fromString(buyerAddr).toScVal(),
            Address.fromString(recipient).toScVal(),
            Address.fromString(this.tokenAddress).toScVal(),
            nativeToScVal(BigInt(deposit), { type: "i128" }),
            nativeToScVal(BigInt(ratePerSecond), { type: "i128" }),
            nativeToScVal(BigInt(durationSecs), { type: "u64" })
          )
        )
        .setTimeout(30)
        .build()
        .toXDR(),
      this.networkPassphrase
    );

    const prepared = await this.rpcServer.prepareTransaction(account);
    prepared.sign(this.buyerKeypair);

    const submit = await this.rpcServer.sendTransaction(prepared);
    if (submit.status === "ERROR") {
      throw new Error(`Tx send failed: ${submit.errorResult}`);
    }

    // Poll status
    let status = await this.rpcServer.getTransaction(submit.hash);
    let retries = 0;
    while (status.status === "NOT_FOUND" && retries < 10) {
      await new Promise((r) => setTimeout(r, 2000));
      status = await this.rpcServer.getTransaction(submit.hash);
      retries++;
    }

    if (status.status !== "SUCCESS") {
      throw new Error(`On-chain open_stream failed with status: ${status.status}`);
    }

    return scValToNative(status.returnValue);
  }

  /**
   * Make a metered API call using the stream token.
   * Handles 402 Payment Required errors automatically.
   */
  async call(streamToken, payload, { attestation = null } = {}) {
    try {
      // Metering refuses unattested calls, so the seller's attestation rides
      // along with the meter request rather than being reported separately.
      const body = attestation ? { ...payload, attestation } : payload;
      return await this._request("POST", "/api/v1/protocol/meter", body, {
        Authorization: `Bearer ${streamToken}`,
      });
    } catch (err) {
      if (err.status === 402) {
        throw new Error("Payment Required: Stream balance exhausted or expired (402)");
      }
      throw err;
    }
  }

  /**
   * Retrieve the claimable balance of the stream.
   */
  async getBalance(streamId) {
    const res = await this._request("GET", `/api/v1/protocol/stream/${streamId}/balance`);
    return res.claimable;
  }

  // ── Attestation: seller side ───────────────────────────────────────────────

  /**
   * Sign an attestation for a call this agent just served.
   *
   * Attach the result to the API response and the buyer can prove, without
   * trusting the backend or this SDK, that the call happened and that it was
   * this seller who said so.
   *
   *   const result = await handleRequest(req);
   *   return { ...result, attestation: sdk.attestCall(streamId, req, result) };
   *
   * The call index advances locally. After a restart, seed it from the last
   * index the backend archived (`GET .../attestations/next-index`) via
   * `seedAttestationIndex`, or the first attestation after the restart is
   * rejected as non-monotonic.
   */
  attestCall(streamId, request, response) {
    if (!this._attestationBuilder) {
      throw new Error("sellerKeypair is required to attest calls");
    }
    return this._attestationBuilder.attest({ streamId, request, response });
  }

  /**
   * Wrap an existing response handler so every response carries an attestation.
   *
   * This is the drop-in path: the handler keeps its signature and its return
   * shape, and gains an `attestation` field.
   */
  attestHandler(handler, options) {
    if (!this._attestationBuilder) {
      throw new Error("sellerKeypair is required to attest calls");
    }
    return this._attestationBuilder.wrap(handler, options);
  }

  /** Restore the local call-index counter after a restart. */
  async seedAttestationIndex(streamId) {
    const res = await this._request(
      "GET",
      `/api/v1/protocol/stream/${streamId}/attestations/next-index`
    );
    this._attestationBuilder?.seed(streamId, res.lastCallIndex);
    return res.lastCallIndex;
  }

  // ── Attestation: buyer side ────────────────────────────────────────────────

  /**
   * Verify one attestation against the seller's public key.
   *
   * Entirely local: no network, no backend, no trust. `sellerPublicKey`
   * defaults to whatever the attestation claims, which is only meaningful if
   * you already know the seller's address — pass it explicitly to check that
   * the attestation came from the party you are actually paying.
   *
   * @returns {{valid: boolean, reason: string, message: string|null,
   *   provableOnChain: boolean}}
   */
  verifyAttestation(attestation, sellerPublicKey) {
    return this._attestationVerifier.check(attestation, { signer: sellerPublicKey });
  }

  /**
   * Verify a whole archived batch against its on-chain commitment.
   *
   * Fetches the archived attestations, re-derives the Merkle root locally, and
   * compares it to the root the backend claims was committed. A mismatch means
   * the archive and the commitment disagree — whether because the seller lied
   * or the backend tampered, the batch should not be trusted either way.
   */
  async verifyBatch(streamId, batchId, sellerPublicKey) {
    const archived = await this._request(
      "GET",
      `/api/v1/protocol/stream/${streamId}/attestations/${batchId}`
    );

    const signer = sellerPublicKey || archived.batch.seller;
    const setResult = this._attestationVerifier.checkSet(archived.attestations, {
      signer,
      streamId: Number(streamId),
      startingIndex: archived.batch.firstCallIndex - 1,
    });

    let recomputedRoot = null;
    try {
      recomputedRoot = MerkleBatchBuilder.build(archived.attestations).root;
    } catch {
      // A set that will not form a tree (a gap in the indices, say) is itself
      // the finding; recomputedRoot stays null and rootMatches stays false.
    }

    const commitmentValid = MerkleBatchBuilder.verifyBatchSignature(
      {
        streamId: Number(streamId),
        merkleRoot: archived.batch.merkleRoot,
        callCount: archived.batch.callCount,
        batchSignature: archived.batch.batchSignature,
      },
      signer
    );

    return {
      batch: archived.batch,
      valid:
        recomputedRoot === archived.batch.merkleRoot && commitmentValid && setResult.valid,
      recomputedRoot,
      committedRoot: archived.batch.merkleRoot,
      rootMatches: recomputedRoot === archived.batch.merkleRoot,
      commitmentValid,
      leafResults: setResult.results,
      firstInvalidIndex: setResult.firstInvalidIndex,
      disputableCallIndex:
        setResult.firstInvalidIndex === null
          ? null
          : archived.batch.firstCallIndex + setResult.firstInvalidIndex,
    };
  }

  /**
   * Challenge a specific call in a committed batch, on-chain.
   *
   * Fetches the archived proof, checks locally that it actually reproduces the
   * committed root, and only then spends a transaction on it — a proof that
   * cannot reach the root would be rejected by the contract anyway, and the
   * buyer would have paid for the privilege.
   *
   * @param {number} streamId
   * @param {number} batchId - the on-chain batch id
   * @param {number} callIndex - the call being contested
   * @returns {{txHash: string, voidedCalls: number}}
   */
  async challengeBatch(streamId, batchId, callIndex) {
    const contractId = this.micropaymentsContractId;
    if (!contractId) {
      throw new Error("micropaymentsContractId is required to submit a challenge");
    }

    const { attestation, proof, rootMatches, verdict, voidableCalls } = await this._request(
      "GET",
      `/api/v1/protocol/stream/${streamId}/attestations/${batchId}/proof/${callIndex}`
    );

    if (!rootMatches) {
      throw new Error(
        "Archived attestations do not reproduce the committed root; the archive " +
          "itself is inconsistent and this proof would be rejected on-chain"
      );
    }
    if (verdict.valid) {
      throw new Error(
        `Call ${callIndex} carries a valid attestation; there is nothing to challenge`
      );
    }

    const buyerAddr = this.buyerKeypair.publicKey();
    const account = await this.rpcServer.getAccount(buyerAddr);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        new Contract(contractId).call(
          "challenge_usage_batch",
          Address.fromString(buyerAddr).toScVal(),
          nativeToScVal(BigInt(streamId), { type: "u64" }),
          nativeToScVal(BigInt(batchId), { type: "u64" }),
          this._attestationLeafToScVal(attestation),
          nativeToScVal(
            proof.map((hash) => toFixedBuffer(hash, 32, "proof element")),
            { type: "bytes" }
          )
        )
      )
      .setTimeout(60)
      .build();

    const prepared = await this.rpcServer.prepareTransaction(tx);
    prepared.sign(this.buyerKeypair);

    const submit = await this.rpcServer.sendTransaction(prepared);
    if (submit.status === "ERROR") {
      throw new Error(`Challenge submission failed: ${JSON.stringify(submit.errorResult)}`);
    }

    let status = await this.rpcServer.getTransaction(submit.hash);
    let retries = 0;
    while (status.status === "NOT_FOUND" && retries < 10) {
      await new Promise((r) => setTimeout(r, 2000));
      status = await this.rpcServer.getTransaction(submit.hash);
      retries++;
    }

    if (status.status !== "SUCCESS") {
      throw new Error(`Challenge rejected on-chain with status: ${status.status}`);
    }

    return {
      txHash: submit.hash,
      voidedCalls: Number(scValToNative(status.returnValue)),
      expectedVoidedCalls: voidableCalls,
    };
  }

  /**
   * Marshal an attestation into the contract's AttestationLeaf struct.
   *
   * Field names and types have to match the #[contracttype] exactly — Soroban
   * maps a struct to a symbol-keyed map, so a misspelled key is a decode error
   * rather than a silently ignored field.
   */
  _attestationLeafToScVal(attestation) {
    return nativeToScVal(
      {
        stream_id: BigInt(attestation.stream_id),
        call_index: BigInt(attestation.call_index),
        request_hash: toFixedBuffer(attestation.request_hash, 32, "request_hash"),
        response_hash: toFixedBuffer(attestation.response_hash, 32, "response_hash"),
        timestamp: BigInt(attestation.timestamp),
        nonce: toFixedBuffer(attestation.nonce, 32, "nonce"),
        signature: toFixedBuffer(attestation.signature, 64, "signature"),
      },
      {
        type: {
          stream_id: ["symbol", "u64"],
          call_index: ["symbol", "u64"],
          request_hash: ["symbol", "bytes"],
          response_hash: ["symbol", "bytes"],
          timestamp: ["symbol", "u64"],
          nonce: ["symbol", "bytes"],
          signature: ["symbol", "bytes"],
        },
      }
    );
  }

  /**
   * Cancel stream on-chain (sender only) and reclaim remaining deposit.
   */
  async closeStream(streamId) {
    const contractId = this.micropaymentsContractId;
    if (!contractId) {
      // In mock/test environments, trigger settlement/cancellation off-chain
      return this._request("POST", `/api/v1/protocol/stream/${streamId}/cancel`);
    }

    const buyerAddr = this.buyerKeypair.publicKey();
    const res = await fetch(`${this.horizonUrl}/accounts/${buyerAddr}`);
    if (!res.ok) throw new Error("Horizon account load failed");
    const accountData = await res.json();

    const tx = new TransactionBuilder(
      {
        sequence: accountData.sequence,
        accountId: buyerAddr,
      },
      { fee: BASE_FEE, networkPassphrase: this.networkPassphrase }
    )
      .addOperation(
        new Contract(contractId).call(
          "cancel_stream",
          Address.fromString(buyerAddr).toScVal(),
          nativeToScVal(BigInt(streamId), { type: "u64" })
        )
      )
      .setTimeout(30)
      .build();

    const prepared = await this.rpcServer.prepareTransaction(tx);
    prepared.sign(this.buyerKeypair);

    const submit = await this.rpcServer.sendTransaction(prepared);
    if (submit.status === "ERROR") {
      throw new Error(`Tx send failed: ${submit.errorResult}`);
    }

    return { txHash: submit.hash };
  }
}

module.exports = CortexAgentSDK;
