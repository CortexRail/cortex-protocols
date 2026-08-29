/**
 * FraudProofBuilder — given a revoked on-chain close attempt, assembles a
 * punishment claim.
 *
 * The claim is deliberately minimal: the contract's `punish(challenger,
 * channel_id, revocation_secret)` needs nothing but the bare secret — no
 * balances, no the-other signed state — so that is all this builds. See
 * `contract/contracts/channels/src/lib.rs`'s module doc for why `punish`
 * only needs a secret where `dispute` needs a whole state: the secret proves
 * revocation on its own, once the pending close's own
 * `revocation_commit_a`/`_b` fields are known (they are always public,
 * posted on-chain by `close_unilateral` itself).
 */

class FraudProofBuilder {
  /**
   * @param {import('./RevocationStore')} revocationStore
   */
  constructor({ revocationStore }) {
    this.revocationStore = revocationStore;
  }

  /**
   * @param {number|string} channelId
   * @param {number|string} revokedVersion - the version an on-chain
   *   `close_unilateral`/pending state is resting on
   * @returns {{channelId, version, party: 'a'|'b', revocationSecret: string}|null}
   *   a claim ready to pass as `punish`'s `revocation_secret`, or `null` if
   *   this store holds no revealed secret for that version (nothing to
   *   punish — the pending close may well be honest).
   */
  build(channelId, revokedVersion) {
    for (const party of ["a", "b"]) {
      const secret = this.revocationStore.revealedSecretFor(channelId, revokedVersion, party);
      if (secret) {
        return { channelId, version: revokedVersion, party, revocationSecret: secret };
      }
    }
    return null;
  }
}

module.exports = FraudProofBuilder;
