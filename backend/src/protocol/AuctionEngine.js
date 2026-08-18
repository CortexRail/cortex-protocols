const { nativeToScVal } = require("@stellar/stellar-sdk");

// Phase names used by the marketplace contract (AuctionPhase enum).
const PHASES = { COMMIT: "Commit", REVEAL: "Reveal", SETTLED: "Settled" };

// In-memory mirror of tracked auctions: auctionId -> snapshot.
const trackedAuctions = new Map();

// SSE clients subscribed to auction phase transitions: Set<Response>.
const sseClients = new Set();

function broadcast(event, payload) {
  const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(message);
    } catch (_err) {
      sseClients.delete(client);
    }
  }
}

function registerClient(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  res.write("data: {\"status\":\"connected\"}\n\n");
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
}

function isSettled(snapshot) {
  return snapshot.phase === PHASES.SETTLED;
}

/**
 * Orchestrates the on-chain sealed-bid auction lifecycle.
 *
 * Watches tracked auctions and drives the phase transitions the contract
 * requires: `begin_reveal` once the commit window closes, and
 * `settle_auction` once the (possibly anti-sniping-extended) reveal window
 * closes. Phase changes are broadcast to SSE subscribers as `REVEAL_OPENED`
 * and `SETTLED` events; `AUCTION_UPDATED` fires on any observable change
 * (e.g. an anti-sniping extension).
 *
 * When no marketplace contract is configured, the engine falls back to a
 * deterministic mock mode so integrations and tests can run without a chain.
 */
class AuctionEngine {
  /**
   * @param {object} [options]
   * @param {string} [options.marketplaceContractId] - Deployed marketplace
   *   contract address. When omitted, transitions are simulated.
   * @param {object} [options.rpcServer] - Soroban RPC server (real mode only).
   * @param {object} [options.keypair] - Stellar keypair that signs transition
   *   transactions (must be able to pay fees; any account may call
   *   begin_reveal/settle_auction).
   * @param {Function} [options.getLedgerSequence] - Async ledger-sequence
   *   provider. Defaults to RPC getLatestLedger in real mode and a fixed
   *   mock sequence otherwise.
   * @param {number} [options.pollIntervalMs] - Interval for the built-in
   *   poller (default 10s).
   */
  constructor(options = {}) {
    this.marketplaceContractId = options.marketplaceContractId || null;
    this.rpcServer = options.rpcServer || null;
    this.keypair = options.keypair || null;
    this.pollIntervalMs = options.pollIntervalMs || 10_000;
    this._getLedgerSequence = options.getLedgerSequence || null;
    this._timer = null;
    this._stopped = true;
  }

  async _ledgerSequence() {
    if (this._getLedgerSequence) {
      return Number(await this._getLedgerSequence());
    }
    if (this.rpcServer) {
      const ledger = await this.rpcServer.getLatestLedger();
      return Number(ledger.sequence);
    }
    return Math.floor(Date.now() / 1000);
  }

  /**
   * Start watching an auction.
   *
   * @param {number} auctionId
   * @param {object} [snapshot] - Initial state used in mock mode, or to
   *   short-circuit the first on-chain read. Shape:
   *   { phase, openLedger, durationLedgers, revealEnd, capacity, minBid, assetId }
   */
  track(auctionId, snapshot = null) {
    const id = Number(auctionId);
    if (snapshot) {
      trackedAuctions.set(id, {
        id,
        phase: snapshot.phase || PHASES.COMMIT,
        openLedger: Number(snapshot.openLedger),
        durationLedgers: Number(snapshot.durationLedgers),
        revealEnd: snapshot.revealEnd ? Number(snapshot.revealEnd) : null,
        capacity: snapshot.capacity ? Number(snapshot.capacity) : null,
        minBid: snapshot.minBid != null ? Number(snapshot.minBid) : null,
        assetId: snapshot.assetId != null ? Number(snapshot.assetId) : null,
      });
    } else {
      trackedAuctions.set(id, { id, phase: PHASES.COMMIT });
    }
    return this;
  }

  untrack(auctionId) {
    trackedAuctions.delete(Number(auctionId));
    return this;
  }

  listTracked() {
    return [...trackedAuctions.values()];
  }

  /**
   * Fetch the on-chain auction state when a contract is configured.
   * Returns null when unavailable (falls back to the local mirror).
   */
  async _fetchOnChain(auctionId) {
    if (!this.marketplaceContractId || !this.rpcServer) return null;
    try {
      const { viewContract } = require("../services/stellarService");
      const raw = await viewContract(
        this.marketplaceContractId,
        "get_auction",
        [nativeToScVal(BigInt(auctionId), { type: "u64" })],
        this.keypair ? this.keypair.publicKey() : "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"
      );
      if (!raw) return null;
      return {
        id: Number(raw.id),
        phase: String(raw.phase),
        openLedger: Number(raw.open_ledger),
        durationLedgers: Number(raw.duration_ledgers),
        revealEnd: raw.reveal_end ? Number(raw.reveal_end) : null,
        capacity: Number(raw.capacity),
        minBid: Number(raw.min_bid),
        assetId: Number(raw.asset_id),
      };
    } catch (_err) {
      return null;
    }
  }

  async _invoke(method, args) {
    if (!this.marketplaceContractId || !this.rpcServer || !this.keypair) {
      return { simulated: true };
    }
    const { invokeContract } = require("../services/stellarService");
    const result = await invokeContract(
      this.marketplaceContractId,
      method,
      args,
      this.keypair
    );
    return { simulated: false, result };
  }

  async _beginReveal(auctionId, snapshot) {
    const { simulated } = await this._invoke("begin_reveal", [
      nativeToScVal(BigInt(auctionId), { type: "u64" }),
    ]);
    const now = await this._ledgerSequence();
    if (simulated) {
      snapshot.phase = PHASES.REVEAL;
      snapshot.revealEnd = now + snapshot.durationLedgers;
    }
    this._emit("REVEAL_OPENED", snapshot, { simulated });
  }

  async _settle(auctionId, snapshot) {
    const { simulated, result } = await this._invoke("settle_auction", [
      nativeToScVal(BigInt(auctionId), { type: "u64" }),
    ]);
    if (simulated) {
      snapshot.phase = PHASES.SETTLED;
    }
    let winners = null;
    let clearingPrice = null;
    if (result && typeof result === "object") {
      winners = result.winners || null;
      clearingPrice = result.clearing_price != null ? Number(result.clearing_price) : null;
    }
    this._emit("SETTLED", snapshot, { simulated, winners, clearingPrice });
  }

  _emit(event, snapshot, extra = {}) {
    broadcast(event, { auctionId: snapshot.id, phase: snapshot.phase, ...extra });
  }

  /**
   * One evaluation pass over all tracked auctions. Runs every transition
   * whose window has elapsed. Returns the list of transitions performed.
   */
  async tick() {
    const now = await this._ledgerSequence();
    const transitions = [];

    for (const snapshot of trackedAuctions.values()) {
      const result = await this._evaluate(snapshot, now);
      if (result) transitions.push(result);
    }

    return transitions;
  }

  /**
   * Evaluate a single tracked auction at the current ledger, running its
   * transition if its window has elapsed.
   */
  async tickFor(auctionId) {
    const snapshot = trackedAuctions.get(Number(auctionId));
    if (!snapshot) {
      return { auctionId: Number(auctionId), skipped: "not-tracked" };
    }
    const now = await this._ledgerSequence();
    const result = await this._evaluate(snapshot, now);
    return result || { auctionId: Number(auctionId), skipped: "no-transition" };
  }

  async _evaluate(snapshot, now) {
    const auctionId = snapshot.id;
    if (isSettled(snapshot)) return null;

    // In real mode, refresh from chain so anti-sniping extensions and
    // external reveals are honored.
    if (this.marketplaceContractId && snapshot.phase === PHASES.REVEAL) {
      const fresh = await this._fetchOnChain(auctionId);
      if (fresh && fresh.phase === PHASES.REVEAL) {
        if (snapshot.revealEnd !== fresh.revealEnd) {
          const previous = snapshot.revealEnd;
          snapshot.revealEnd = fresh.revealEnd;
          this._emit("AUCTION_UPDATED", snapshot, { previousRevealEnd: previous });
        }
      } else if (fresh && fresh.phase === PHASES.SETTLED) {
        snapshot.phase = PHASES.SETTLED;
        this._emit("SETTLED", snapshot, { observed: true });
        return { auctionId, transition: "settle_auction", ledger: now, observed: true };
      }
    }

    if (snapshot.phase === PHASES.COMMIT) {
      const commitEnd = snapshot.openLedger + snapshot.durationLedgers;
      if (now >= commitEnd) {
        await this._beginReveal(auctionId, snapshot);
        return { auctionId, transition: "begin_reveal", ledger: now };
      }
    } else if (snapshot.phase === PHASES.REVEAL) {
      if (snapshot.revealEnd != null && now >= snapshot.revealEnd) {
        await this._settle(auctionId, snapshot);
        return { auctionId, transition: "settle_auction", ledger: now };
      }
    }
    return null;
  }

  /**
   * Start the periodic poller. No-op when already running.
   */
  start() {
    if (this._timer) return this;
    this._stopped = false;
    this._timer = setInterval(() => {
      this.tick().catch((err) => {
        console.error("[AuctionEngine] tick failed:", err.message);
      });
    }, this.pollIntervalMs);
    this._timer.unref?.();
    return this;
  }

  /**
   * Stop the periodic poller (and allow further manual ticks).
   */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._stopped = true;
    return this;
  }
}

module.exports = {
  AuctionEngine,
  PHASES,
  registerClient,
  broadcast,
  _trackedAuctions: trackedAuctions,
  _sseClients: sseClients,
  // Default engine used by the protocol routes (also usable standalone).
  engine: new AuctionEngine(),
};