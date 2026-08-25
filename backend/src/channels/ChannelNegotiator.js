/**
 * ChannelNegotiator — the off-chain update handshake: propose, counter-sign,
 * ack, complete.
 *
 * One instance per party, per channel. Each side holds its own Ed25519
 * keypair and its own RevocationStore — there is no shared process, no
 * trusted intermediary, and each party's revocation secrets never leave
 * that party's own machine until deliberately revealed.
 *
 * ── The five steps ─────────────────────────────────────────────────────────
 *
 *   1. propose()    — proposer picks a new version + balances, generates
 *                      *its own* revocation commitment for that version,
 *                      sends {version, balances, proposerCommit}.
 *   2. counterSign() — counterparty generates its own commitment, builds the
 *                      full (still one-sided) signed state, sends back its
 *                      {commitmentHash, signature}.
 *   3. ack()         — proposer combines both commitments + both intended
 *                      signatures into the fully dual-signed state, verifies
 *                      it, and *only then* reveals its own previous-version
 *                      secret. Sends {state, revealedSecret}.
 *   4. complete()    — counterparty verifies the final dual-signed state,
 *                      records the proposer's revealed secret, and reveals
 *                      its own previous-version secret in turn.
 *   5. finalize()    — proposer records the counterparty's revealed secret
 *                      from step 4. Both sides now hold the same current
 *                      state, and both previous-version secrets are mutually
 *                      known.
 *
 * ── Why this ordering is safe against a counterparty who abandons halfway ──
 *
 * The dangerous failure mode for any revocation scheme is ending up with
 * your *old* state revoked while your *new* state never finished being
 * signed — a counterparty who vanishes at exactly that point leaves you
 * holding nothing valid at all, having handed them the means to punish you
 * for whatever you try to close with instead.
 *
 * This protocol makes that impossible by construction: a party reveals its
 * own previous-version secret (step 3 for the proposer, step 4 for the
 * counterparty) *only after* it already holds a state that verifies under
 * both signatures. If the counterparty disappears at any earlier point —
 * after step 1, after step 2, even after step 3 if step 4 never arrives for
 * the proposer's side of the story — the party that has not yet revealed
 * still has its old, unrevoked, fully closable state sitting untouched. The
 * worst an abandoned handshake costs either side is one unused RevocationStore
 * commitment slot for a version that never became current — never money, and
 * never a state the other side can deny having agreed to, because nothing
 * before "current" ever changes.
 */

const ChannelState = require("./ChannelState");
const { signingMessage } = require("./canonical");

function otherParty(party) {
  return party === "a" ? "b" : "a";
}

class ChannelNegotiator {
  /**
   * @param {object} config
   * @param {number|string} config.channelId
   * @param {'a'|'b'} config.party - which side this instance represents
   * @param {import('@stellar/stellar-sdk').Keypair} config.keypair - this
   *   party's signing key
   * @param {string} config.counterpartyPublicKey - the other party's G...
   *   address, used to verify their half of each new state
   * @param {import('./RevocationStore')} config.revocationStore - this
   *   party's own store; never shared with the counterparty's process
   * @param {object} [config.initialState] - a fully dual-signed state to
   *   start from (e.g. the version negotiated immediately after
   *   open_channel); omit for a negotiator that will itself run the very
   *   first negotiation
   */
  constructor({ channelId, party, keypair, counterpartyPublicKey, revocationStore, initialState = null }) {
    if (party !== "a" && party !== "b") throw new Error('party must be "a" or "b"');
    this.channelId = channelId;
    this.party = party;
    this.counterpartyParty = otherParty(party);
    this.keypair = keypair;
    this.counterpartyPublicKey = counterpartyPublicKey;
    this.revocationStore = revocationStore;
    this.currentState = initialState;
    this._pending = null;
  }

  _myPublicKey() {
    return this.keypair.publicKey();
  }

  _partyPublicKeys() {
    return this.party === "a"
      ? { a: this._myPublicKey(), b: this.counterpartyPublicKey }
      : { a: this.counterpartyPublicKey, b: this._myPublicKey() };
  }

  /**
   * Step 1. Propose a new version with new balances.
   *
   * @returns {object} the Proposal message to send to the counterparty
   */
  propose({ version, balanceA, balanceB }) {
    if (this._pending) {
      throw new Error("a negotiation is already in flight for this channel");
    }
    if (this.currentState && Number(version) <= Number(this.currentState.version)) {
      throw new Error(
        `version ${version} does not exceed the current version ${this.currentState.version}`
      );
    }

    const commitmentHash = this.revocationStore.commit(this.channelId, version, this.party);
    const proposal = {
      channelId: this.channelId,
      version,
      balanceA,
      balanceB,
      proposerParty: this.party,
      proposerCommitmentHash: commitmentHash,
    };
    this._pending = { role: "proposer", ...proposal };
    return proposal;
  }

  /**
   * Step 2. Countersign a received proposal.
   *
   * Generates this party's own commitment and produces this party's half of
   * the signature. Deliberately does *not* reveal anything about this
   * party's previous state yet — see the module doc.
   *
   * @returns {object} the CounterSignature message to send to the proposer
   */
  counterSign(proposal) {
    if (String(proposal.channelId) !== String(this.channelId)) {
      throw new Error("proposal is for a different channel");
    }
    if (proposal.proposerParty === this.party) {
      throw new Error("cannot countersign your own proposal");
    }
    if (this.currentState && Number(proposal.version) <= Number(this.currentState.version)) {
      throw new Error(
        `proposed version ${proposal.version} does not exceed the current version ${this.currentState.version}`
      );
    }

    this.revocationStore.recordCommitment(
      this.channelId,
      proposal.version,
      proposal.proposerParty,
      proposal.proposerCommitmentHash
    );
    const myCommitmentHash = this.revocationStore.commit(this.channelId, proposal.version, this.party);

    const commits =
      this.party === "a"
        ? { revocationCommitA: myCommitmentHash, revocationCommitB: proposal.proposerCommitmentHash }
        : { revocationCommitA: proposal.proposerCommitmentHash, revocationCommitB: myCommitmentHash };

    const state = ChannelState.createState({
      channelId: this.channelId,
      version: proposal.version,
      balanceA: proposal.balanceA,
      balanceB: proposal.balanceB,
      ...commits,
    });
    const signature = ChannelState.sign(state, this.keypair);

    this._pending = { role: "counterparty", state, myCommitmentHash };
    return {
      channelId: this.channelId,
      version: proposal.version,
      party: this.party,
      commitmentHash: myCommitmentHash,
      signature,
    };
  }

  /**
   * Step 3 (proposer). Accept the counterparty's counter-signature, produce
   * the final dual-signed state, and — only having verified it in full —
   * reveal this party's own previous-version secret.
   *
   * @returns {object} the Ack message to send to the counterparty:
   *   `{ state, revealedVersion, revealedSecret }`, where the last two are
   *   `null` when there was no previous version to revoke (the very first
   *   negotiation on this channel).
   */
  ack(counterSignature) {
    if (!this._pending || this._pending.role !== "proposer") {
      throw new Error("no proposal from this party is awaiting a counter-signature");
    }
    const pending = this._pending;
    if (String(counterSignature.channelId) !== String(this.channelId)) {
      throw new Error("counter-signature is for a different channel");
    }
    if (Number(counterSignature.version) !== Number(pending.version)) {
      throw new Error("counter-signature version does not match the outstanding proposal");
    }

    // Learn the counterparty's commitment hash for this version — mirrors
    // what counterSign() already does for the proposer's side. Without this,
    // this store has no commitment on record to check a later revealed
    // secret against, even though the state itself already carries it.
    this.revocationStore.recordCommitment(
      this.channelId,
      pending.version,
      this.counterpartyParty,
      counterSignature.commitmentHash
    );

    const commits =
      pending.proposerParty === "a"
        ? { revocationCommitA: pending.proposerCommitmentHash, revocationCommitB: counterSignature.commitmentHash }
        : { revocationCommitA: counterSignature.commitmentHash, revocationCommitB: pending.proposerCommitmentHash };

    const unsigned = ChannelState.createState({
      channelId: this.channelId,
      version: pending.version,
      balanceA: pending.balanceA,
      balanceB: pending.balanceB,
      ...commits,
    });

    if (
      !ChannelState.verifySignatureRaw(
        signingMessage(unsigned),
        counterSignature.signature,
        this.counterpartyPublicKey
      )
    ) {
      throw new Error("counterparty's counter-signature does not verify");
    }

    const mySignature = ChannelState.sign(unsigned, this.keypair);
    const withCounterparty = ChannelState.withSignature(
      unsigned,
      this.counterpartyParty,
      counterSignature.signature
    );
    const state = ChannelState.withSignature(withCounterparty, this.party, mySignature);

    const pubkeys = this._partyPublicKeys();
    const verification = ChannelState.verify(state, pubkeys.a, pubkeys.b);
    if (!verification.valid) {
      throw new Error(`assembled state failed verification: ${verification.reason}`);
    }

    // Only now — with a fully verified successor in hand — is it safe to
    // revoke the previous version.
    const previous = this.currentState;
    const revealedSecret = previous ? this.revocationStore.reveal(this.channelId, previous.version, this.party) : null;

    this.currentState = state;
    this._pending = null;

    return {
      channelId: this.channelId,
      state,
      revealedVersion: previous ? previous.version : null,
      revealedParty: previous ? this.party : null,
      revealedSecret,
      // The full superseded state, not just its version — a caller wiring
      // up Watchtower.register() needs this to compute the old state's
      // commitment hash; it's otherwise gone once currentState moves on.
      revokedState: previous,
    };
  }

  /**
   * Step 4 (counterparty). Verify the proposer's ack, record their revealed
   * secret, and — only now — reveal this party's own previous-version
   * secret in turn.
   *
   * @returns {object} the Completion message to send back to the proposer:
   *   `{ revealedVersion, revealedSecret, revokedState }`, `null` fields on
   *   the first negotiation, same as `ack()`.
   */
  complete(ack) {
    if (!this._pending || this._pending.role !== "counterparty") {
      throw new Error("no counter-signature from this party is awaiting an ack");
    }
    const pending = this._pending;
    if (String(ack.channelId) !== String(this.channelId)) {
      throw new Error("ack is for a different channel");
    }

    const pubkeys = this._partyPublicKeys();
    const verification = ChannelState.verify(ack.state, pubkeys.a, pubkeys.b);
    if (!verification.valid) {
      throw new Error(`proposer's assembled state failed verification: ${verification.reason}`);
    }
    if (
      Number(ack.state.channel_id) !== Number(this.channelId) ||
      Number(ack.state.version) !== Number(pending.state.version)
    ) {
      throw new Error("ack state does not match the outstanding counter-signature");
    }

    if (ack.revealedSecret) {
      this.revocationStore.recordRevealedSecret(
        this.channelId,
        ack.revealedVersion,
        ack.revealedParty,
        ack.revealedSecret
      );
    }

    const previous = this.currentState;
    const revealedSecret = previous ? this.revocationStore.reveal(this.channelId, previous.version, this.party) : null;

    this.currentState = ack.state;
    this._pending = null;

    return {
      channelId: this.channelId,
      revealedVersion: previous ? previous.version : null,
      revealedParty: previous ? this.party : null,
      revealedSecret,
      revokedState: previous,
    };
  }

  /**
   * Step 5 (proposer). Record the counterparty's revealed secret from
   * `complete()`. Purely bookkeeping — both sides already hold the same
   * `currentState` by this point.
   */
  finalize(completion) {
    if (completion.revealedSecret) {
      this.revocationStore.recordRevealedSecret(
        this.channelId,
        completion.revealedVersion,
        completion.revealedParty,
        completion.revealedSecret
      );
    }
  }
}

module.exports = ChannelNegotiator;
