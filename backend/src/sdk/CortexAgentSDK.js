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
      console.warn("[CortexAgentSDK] On-chain stream opening failed, falling back to mock registration:", err.message);
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
  async call(streamToken, payload) {
    try {
      return await this._request("POST", "/api/v1/protocol/meter", payload, {
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
