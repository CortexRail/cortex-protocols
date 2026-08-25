//! Canonical channel-state encoding — signing, hashing, and the struct both
//! off-chain parties sign.
//!
//! Byte-for-byte identical to `backend/src/channels/canonical.js`; that file
//! carries the full field table and the rationale for embedding the two
//! revocation commitments in the signed bytes rather than registering them
//! separately. In brief, the preimage is 96 fixed-width big-endian bytes:
//!
//! ```text
//! offset  size  field
//! ------  ----  -------------------------------------------------------
//!      0     8  channel_id            u64 BE
//!      8     8  version               u64 BE
//!     16     8  balance_a             u64 BE
//!     24     8  balance_b             u64 BE
//!     32    32  revocation_commit_a   sha256(party A's secret for this version)
//!     64    32  revocation_commit_b   sha256(party B's secret for this version)
//! ```
//!
//! and the signed message is `0x10 || PREIMAGE` (domain tag 0x10, kept clear
//! of the attestation module's 0x00/0x01/0x02 so the two signature schemes
//! can never be confused with each other).

use soroban_sdk::{contracttype, Bytes, BytesN, Env};

/// Domain tag. Keep in lockstep with `backend/src/channels/canonical.js`.
pub const DOMAIN_CHANNEL_STATE: u8 = 0x10;

/// A dual-signed, monotonically versioned balance pair.
///
/// Only meaningful with both `sig_a` and `sig_b` present and verifying —
/// neither party can move funds unilaterally, which is what lets `dispute`
/// trust any state that merely verifies: it cannot exist without both
/// parties having signed off on it.
///
/// `revocation_commit_a`/`_b` are each party's RevocationStore commitment
/// hash for *this* version (see the module doc). Signing them alongside the
/// balances is what lets `punish` prove a bare revealed secret revokes this
/// exact version using only what `close_unilateral` already put in storage.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChannelState {
    pub channel_id: u64,
    pub version: u64,
    pub balance_a: u64,
    pub balance_b: u64,
    pub revocation_commit_a: BytesN<32>,
    pub revocation_commit_b: BytesN<32>,
    pub sig_a: BytesN<64>,
    pub sig_b: BytesN<64>,
}

/// `0x10 || PREIMAGE` — the exact bytes both parties Ed25519-sign, and the
/// commitment-hash preimage. Deliberately excludes `sig_a`/`sig_b`.
pub(crate) fn signing_message(env: &Env, state: &ChannelState) -> Bytes {
    let mut msg = Bytes::new(env);
    msg.extend_from_array(&[DOMAIN_CHANNEL_STATE]);
    msg.extend_from_array(&state.channel_id.to_be_bytes());
    msg.extend_from_array(&state.version.to_be_bytes());
    msg.extend_from_array(&state.balance_a.to_be_bytes());
    msg.extend_from_array(&state.balance_b.to_be_bytes());
    msg.extend_from_array(&state.revocation_commit_a.to_array());
    msg.extend_from_array(&state.revocation_commit_b.to_array());
    msg
}

/// `commitment_hash = sha256(signing_message)` — the value a Watchtower blob
/// is keyed on, letting it hold a justice transaction without ever learning
/// the channel's balances.
pub(crate) fn commitment_hash(env: &Env, state: &ChannelState) -> BytesN<32> {
    env.crypto().sha256(&signing_message(env, state)).into()
}

/// Verify both signatures over `state`, strict: panics (via
/// `ed25519_verify`) on the first bad one. This is the "must be good or the
/// whole call fails" mode — used everywhere a state is *accepted* (open,
/// close, dispute). Nothing here ever needs the catchable/boolean mode: a
/// `punish` claim never re-checks Ed25519 at all, it only compares a sha256
/// of a revealed secret against a commitment already bound into a state that
/// was strictly verified when it was first accepted.
pub(crate) fn verify_dual_signature(
    env: &Env,
    state: &ChannelState,
    pubkey_a: &BytesN<32>,
    pubkey_b: &BytesN<32>,
) {
    let message = signing_message(env, state);
    env.crypto()
        .ed25519_verify(pubkey_a, &message, &state.sig_a);
    env.crypto()
        .ed25519_verify(pubkey_b, &message, &state.sig_b);
}
