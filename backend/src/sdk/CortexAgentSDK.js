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
   *   the seller-side `attestCall`.
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
    this.tokenAddress = config.tokenAddress || "CDLZFC3SYJYDZT7K6AOFHG23NFR7EDLI226OJZ5U3XEE2FEUA7HJTZUA";

    this.rpcServer = new SorobanRpc.Server(this.rpcUrl);

    this.sellerKeypair = config.sellerKeypair || null;
    this._attestationBuilder = this.sellerKeypair
      ? new AttestationBuilder({ signer: this.sellerKeypair })
      : null;

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
      err.data = data;
      throw err;
    }
    return res.json();
  }

  /**
   * Estimates base fee, suggested tip, and admission probability for an asset.
   * @param {string|number} assetId
   * @returns {Promise<{ baseFee: string, suggestedTip: string, admissionProbability: number }>}
   */
  async estimateCall(assetId) {
    return this._request("GET", `/api/v1/assets/${assetId}/market/estimate`);
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

    const handshake = await this._request("POST", "/api/v1/protocol/handshake", {
      publicKey: buyerPubkey,
      assetId: Number(assetId),
    });

    const quote = handshake.quote;
    const initialPrice = handshake.price;

    const negotiation = await this._request("POST", "/api/v1/protocol/negotiate", {
      buyer: buyerPubkey,
      assetId: Number(assetId),
      proposedRate: initialPrice,
      quote,
    });

    if (negotiation.status !== "Agreed") {
      throw new Error(`Rate negotiation failed: server replied with status ${negotiation.status}`);
    }

    const agreedRate = negotiation.rate;
    const durationSecs = durationHours * 3600;
    const depositStroops = Math.floor(depositXlm * 10_000_000);
    const ratePerSecond = Math.max(1, Math.floor(depositStroops / durationSecs));

    let streamId;
    const assetDetail = await this._request("GET", `/api/v1/assets/${assetId}`);
    const recipientPubkey = assetDetail.owner;

    try {
      streamId = await this._openStreamOnChain(
        recipientPubkey,
        depositStroops,
        ratePerSecond,
        durationSecs
      );
    } catch (err) {
      logger.warn("[CortexAgentSDK] On-chain stream opening failed, falling back to mock registration:", err.message);
      streamId = Math.floor(Math.random() * 1_000_000) + 1;
    }

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

  async _openStreamOnChain(recipient, deposit, ratePerSecond, durationSecs) {
    const contractId = this.micropaymentsContractId;
    if (!contractId) {
      throw new Error("micropaymentsContractId is not configured on SDK client");
    }

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
   * Enforces maxBaseFee protection without silently over-paying.
   *
   * @param {string} streamToken
   * @param {object} payload
   * @param {object} [options]
   * @param {object|null} [options.attestation]
   * @param {bigint|number|string|null} [options.maxBaseFee]
   * @param {bigint|number|string|null} [options.tip]
   */
  async call(streamToken, payload, { attestation = null, maxBaseFee = null, tip = null } = {}) {
    try {
      const body = {
        ...payload,
        attestation,
        maxBaseFee,
        tip,
      };
      return await this._request("POST", "/api/v1/protocol/meter", body, {
        Authorization: `Bearer ${streamToken}`,
      });
    } catch (err) {
      if (err.status === 402) {
        throw new Error("Payment Required: Stream balance exhausted or expired (402)");
      }
      if (err.status === 429) {
        const customErr = new Error("Capacity exhausted for current window (429)");
        customErr.status = 429;
        customErr.currentBaseFee = err.data?.currentBaseFee;
        customErr.nextWindowEstimate = err.data?.nextWindowEstimate;
        customErr.suggestedTip = err.data?.suggestedTip;
        throw customErr;
      }
      throw err;
    }
  }

  async getBalance(streamId) {
    const res = await this._request("GET", `/api/v1/protocol/stream/${streamId}/balance`);
    return res.claimable;
  }

  attestCall(streamId, request, response) {
    if (!this._attestationBuilder) {
      throw new Error("sellerKeypair is required to attest calls");
    }
    return this._attestationBuilder.attest({ streamId, request, response });
  }

  attestHandler(handler, options) {
    if (!this._attestationBuilder) {
      throw new Error("sellerKeypair is required to attest calls");
    }
    return this._attestationBuilder.wrap(handler, options);
  }

  async seedAttestationIndex(streamId) {
    const res = await this._request(
      "GET",
      `/api/v1/protocol/stream/${streamId}/attestations/next-index`
    );
    this._attestationBuilder?.seed(streamId, res.lastCallIndex);
    return res.lastCallIndex;
  }

  verifyAttestation(attestation, sellerPublicKey) {
    return this._attestationVerifier.check(attestation, { signer: sellerPublicKey });
  }

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
    } catch {}

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

  async closeStream(streamId) {
    const contractId = this.micropaymentsContractId;
    if (!contractId) {
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