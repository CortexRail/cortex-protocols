const {
  Contract,
  TransactionBuilder,
  BASE_FEE,
  Address,
  StrKey,
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
const ChannelNegotiator = require("../channels/ChannelNegotiator");
const RevocationStore = require("../channels/RevocationStore");

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
    this.channelsContractId = config.channelsContractId;
    this.tokenAddress = config.tokenAddress || "CDLZFC3SYJYDZT7K6AOFHG23NFR7EDLI226OJZ5U3XEE2FEUA7HJTZUA";

    this.rpcServer = new SorobanRpc.Server(this.rpcUrl);

    this.sellerKeypair = config.sellerKeypair || null;
    this._attestationBuilder = this.sellerKeypair
      ? new AttestationBuilder({ signer: this.sellerKeypair })
      : null;

    this._attestationVerifier = new AttestationVerifier();

    // channelId -> ChannelNegotiator. One RevocationStore is shared across
    // every channel this agent is party to — RevocationStore already keys
    // everything by channelId internally, so there is no cross-channel
    // leakage in sharing it.
    this._channelNegotiators = new Map();
    this._channelRevocationStore = new RevocationStore();
    // counterparty G-address -> channelId, so payForCallViaChannel can find
    // an existing channel without the caller having to track ids itself.
    this._channelByCounterparty = new Map();
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

  // ── Payment Channels ───────────────────────────────────────────────────

  _requireChannelsContract() {
    if (!this.channelsContractId) {
      throw new Error("channelsContractId is not configured on SDK client");
    }
    return this.channelsContractId;
  }

  /** Sign with each keypair in order, submit, and poll for the result. */
  async _submitTx(tx, signers) {
    const prepared = await this.rpcServer.prepareTransaction(tx);
    for (const kp of signers) prepared.sign(kp);

    const submit = await this.rpcServer.sendTransaction(prepared);
    if (submit.status === "ERROR") {
      throw new Error(`Tx send failed: ${JSON.stringify(submit.errorResult)}`);
    }

    let status = await this.rpcServer.getTransaction(submit.hash);
    let retries = 0;
    while (status.status === "NOT_FOUND" && retries < 10) {
      await new Promise((r) => setTimeout(r, 2000));
      status = await this.rpcServer.getTransaction(submit.hash);
      retries++;
    }
    if (status.status !== "SUCCESS") {
      throw new Error(`Transaction failed with status: ${status.status}`);
    }
    return status.returnValue ? scValToNative(status.returnValue) : null;
  }

  _channelStateToScVal(state) {
    return nativeToScVal(
      {
        channel_id: BigInt(state.channel_id),
        version: BigInt(state.version),
        balance_a: BigInt(state.balance_a),
        balance_b: BigInt(state.balance_b),
        revocation_commit_a: toFixedBuffer(state.revocation_commit_a, 32, "revocation_commit_a"),
        revocation_commit_b: toFixedBuffer(state.revocation_commit_b, 32, "revocation_commit_b"),
        sig_a: toFixedBuffer(state.sig_a, 64, "sig_a"),
        sig_b: toFixedBuffer(state.sig_b, 64, "sig_b"),
      },
      {
        type: {
          channel_id: ["symbol", "u64"],
          version: ["symbol", "u64"],
          balance_a: ["symbol", "u64"],
          balance_b: ["symbol", "u64"],
          revocation_commit_a: ["symbol", "bytes"],
          revocation_commit_b: ["symbol", "bytes"],
          sig_a: ["symbol", "bytes"],
          sig_b: ["symbol", "bytes"],
        },
      }
    );
  }

  /**
   * Register this agent's Ed25519 key for off-chain channel-state signing.
   * Reuses the Stellar account keypair already held — Stellar keys are
   * Ed25519 already, so there is nothing separate to generate or manage.
   * Must be called once before this agent can be a party to any channel.
   */
  async registerChannelKey() {
    const contractId = this._requireChannelsContract();
    const pubkey = this.buyerKeypair.publicKey();
    const account = await this.rpcServer.getAccount(pubkey);

    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: this.networkPassphrase })
      .addOperation(
        new Contract(contractId).call(
          "register_channel_key",
          Address.fromString(pubkey).toScVal(),
          nativeToScVal(StrKey.decodeEd25519PublicKey(pubkey), { type: "bytes" })
        )
      )
      .setTimeout(30)
      .build();

    return this._submitTx(tx, [this.buyerKeypair]);
  }

  /**
   * Open a channel with `counterpartyPubkey`. Both parties fund the
   * channel in the same transaction (see the contract's `open_channel`),
   * so both must authorize it. Pass `counterpartyKeypair` when this
   * process controls both sides (tests, demos, one operator running both
   * agents); otherwise this returns an unsigned-by-them XDR for the
   * counterparty to co-sign and submit out-of-band.
   *
   * @param {string} counterpartyPubkey
   * @param {number} myDepositXlm
   * @param {number} counterpartyDepositXlm
   * @param {object} [opts]
   * @param {Keypair} [opts.counterpartyKeypair]
   */
  async openChannel(counterpartyPubkey, myDepositXlm, counterpartyDepositXlm, { counterpartyKeypair } = {}) {
    const contractId = this._requireChannelsContract();
    const myPubkey = this.buyerKeypair.publicKey();
    const account = await this.rpcServer.getAccount(myPubkey);

    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: this.networkPassphrase })
      .addOperation(
        new Contract(contractId).call(
          "open_channel",
          Address.fromString(myPubkey).toScVal(),
          Address.fromString(counterpartyPubkey).toScVal(),
          Address.fromString(this.tokenAddress).toScVal(),
          nativeToScVal(BigInt(Math.floor(myDepositXlm * 10_000_000)), { type: "i128" }),
          nativeToScVal(BigInt(Math.floor(counterpartyDepositXlm * 10_000_000)), { type: "i128" })
        )
      )
      .setTimeout(30)
      .build();

    if (!counterpartyKeypair) {
      const prepared = await this.rpcServer.prepareTransaction(tx);
      prepared.sign(this.buyerKeypair);
      return { xdr: prepared.toXDR(), needsCounterpartySignature: true };
    }

    const channelId = Number(await this._submitTx(tx, [this.buyerKeypair, counterpartyKeypair]));
    this.joinChannel(channelId, { party: "a", counterpartyPublicKey: counterpartyPubkey });
    return { channelId };
  }

  /**
   * Register a locally-tracked negotiator for a channel this agent is
   * party to. The opener gets this for free from `openChannel`; the
   * counterparty calls it explicitly on learning the new channel_id (from
   * the OPENED event, or told directly by the opener).
   */
  joinChannel(channelId, { party, counterpartyPublicKey, initialState = null }) {
    const negotiator = new ChannelNegotiator({
      channelId,
      party,
      keypair: this.buyerKeypair,
      counterpartyPublicKey,
      revocationStore: this._channelRevocationStore,
      initialState,
    });
    this._channelNegotiators.set(String(channelId), negotiator);
    this._channelByCounterparty.set(counterpartyPublicKey, channelId);
    return negotiator;
  }

  /**
   * Route one call's payment through an existing open channel with
   * `counterpartyPubkey` when this agent has joined one, instead of the
   * ordinary stream-metered path. This is the client-side half of "route
   * metering through a channel when one exists, falling back to the
   * stream path when it does not": the decision has to be made here,
   * locally, because a channel payment is a peer-to-peer balance update
   * (payInChannel), not something the backend brokers the way stream
   * metering is.
   *
   * @param {string} counterpartyPubkey
   * @param {number} pricePerCall
   * @returns {{viaChannel: false}|{viaChannel: true, channelId, proposal}}
   *   `viaChannel: false` means no usable channel was found (never joined
   *   one, or this agent's balance can't cover pricePerCall) — the caller
   *   should fall back to openStream()/call() as usual. Otherwise
   *   `proposal` is the message this agent must still send the
   *   counterparty (who runs it through receiveChannelProposal) to
   *   actually move the balance.
   */
  payForCallViaChannel(counterpartyPubkey, pricePerCall) {
    const channelId = this._channelByCounterparty.get(counterpartyPubkey);
    if (channelId === undefined) return { viaChannel: false };

    const negotiator = this._negotiatorFor(channelId);
    const state = negotiator.currentState;
    if (!state) return { viaChannel: false };

    const mine = negotiator.party === "a" ? Number(state.balance_a) : Number(state.balance_b);
    const theirs = negotiator.party === "a" ? Number(state.balance_b) : Number(state.balance_a);
    if (mine < pricePerCall) return { viaChannel: false };

    const nextMine = mine - pricePerCall;
    const nextTheirs = theirs + pricePerCall;
    const [balanceA, balanceB] =
      negotiator.party === "a" ? [nextMine, nextTheirs] : [nextTheirs, nextMine];

    return { viaChannel: true, channelId, proposal: this.payInChannel(channelId, balanceA, balanceB) };
  }

  _negotiatorFor(channelId) {
    const negotiator = this._channelNegotiators.get(String(channelId));
    if (!negotiator) {
      throw new Error(`no local channel negotiator for channel ${channelId}; call joinChannel first`);
    }
    return negotiator;
  }

  /**
   * Propose the channel's next off-chain balances — the whole point of a
   * channel: this touches no ledger. Returns the Proposal message to send
   * to the counterparty over whatever transport they share.
   */
  payInChannel(channelId, balanceA, balanceB) {
    const negotiator = this._negotiatorFor(channelId);
    const nextVersion = negotiator.currentState ? Number(negotiator.currentState.version) + 1 : 1;
    return negotiator.propose({ version: nextVersion, balanceA, balanceB });
  }

  /** Counterparty side: respond to a received Proposal with a CounterSignature. */
  receiveChannelProposal(channelId, proposal) {
    return this._negotiatorFor(channelId).counterSign(proposal);
  }

  /** Proposer side: accept a CounterSignature, producing an Ack. */
  receiveChannelCounterSignature(channelId, counterSignature) {
    return this._negotiatorFor(channelId).ack(counterSignature);
  }

  /** Counterparty side: accept an Ack, producing a Completion. */
  receiveChannelAck(channelId, ack) {
    return this._negotiatorFor(channelId).complete(ack);
  }

  /** Proposer side: accept a Completion, finishing the round. */
  receiveChannelCompletion(channelId, completion) {
    this._negotiatorFor(channelId).finalize(completion);
  }

  /** This agent's current fully-signed off-chain state for a channel, if any. */
  getChannelState(channelId) {
    return this._negotiatorFor(channelId).currentState;
  }

  /**
   * Close a channel. Cooperative (the default) settles instantly at the
   * current agreed state and needs no counterparty signature on this
   * call — the state's own dual signature already carries their consent.
   * Unilateral instead starts the dispute window, for when the
   * counterparty cannot be reached to cooperatively close.
   */
  async closeChannel(channelId, { cooperative = true } = {}) {
    const contractId = this._requireChannelsContract();
    const state = this._negotiatorFor(channelId).currentState;
    if (!state) {
      throw new Error(`channel ${channelId} has no locally agreed state to close with`);
    }

    const myPubkey = this.buyerKeypair.publicKey();
    const account = await this.rpcServer.getAccount(myPubkey);
    const method = cooperative ? "close_cooperative" : "close_unilateral";
    const args = cooperative
      ? [nativeToScVal(BigInt(channelId), { type: "u64" }), this._channelStateToScVal(state)]
      : [
          Address.fromString(myPubkey).toScVal(),
          nativeToScVal(BigInt(channelId), { type: "u64" }),
          this._channelStateToScVal(state),
        ];

    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: this.networkPassphrase })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(30)
      .build();

    return this._submitTx(tx, [this.buyerKeypair]);
  }

  /**
   * Register this channel's most recently superseded state with a remote
   * watchtower service (POSTs to `${endpoint}/register`), so it can submit
   * `punish` on this agent's behalf if the counterparty ever republishes
   * that state. Call this right after a payInChannel round completes
   * (once this agent has revealed a secret) and before going offline —
   * pass the `revokedState`/`revealedParty`/`revealedSecret` fields from
   * whichever of `receiveChannelAck`/`receiveChannelCompletion` just ran.
   */
  async registerWatchtower(channelId, endpoint, { revokedState, revealedParty, revealedSecret } = {}) {
    if (!revokedState || !revealedSecret) {
      throw new Error(
        "registerWatchtower needs the state that was just superseded plus the secret revealed " +
          "for it — pass revokedState/revealedParty/revealedSecret from the round that just completed"
      );
    }

    const res = await fetch(`${endpoint.replace(/\/$/, "")}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channelId,
        state: revokedState,
        party: revealedParty,
        revocationSecret: revealedSecret,
        challenger: this.buyerKeypair.publicKey(),
      }),
    });
    if (!res.ok) {
      throw new Error(`watchtower registration failed: HTTP ${res.status}`);
    }
    return res.json();
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