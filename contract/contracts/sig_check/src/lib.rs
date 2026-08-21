#![no_std]

//! Ed25519 signature checker, isolated in its own contract so that a *failed*
//! verification is observable instead of fatal.
//!
//! ## Why this contract exists
//!
//! `env.crypto().ed25519_verify` returns `()` and panics when a signature is
//! bad. That is the right shape for the usual case — you want the transaction
//! dead if the signature is wrong — but `challenge_usage_batch` needs the
//! opposite: it is *looking* for a bad signature, and a panic would revert the
//! very transaction meant to record the fraud.
//!
//! The standard escape is `env.try_invoke_contract`, which converts a callee's
//! panic into an `Err`. It cannot be pointed at the calling contract itself:
//! Soroban forbids contract re-entry, so a self-call is rejected before the
//! signature is ever checked. So the check lives here, one hop away, where the
//! panic is catchable.
//!
//! ## Trust
//!
//! Micropayments treats whatever address it has registered as the checker as
//! trusted: a checker that never panics makes every challenge fail, and one
//! that always panics makes every challenge succeed. `set_sig_checker` is
//! therefore write-once — see the note there. This contract holds no state and
//! has no admin, so the deployed WASM is the whole of what has to be trusted.

use soroban_sdk::{contract, contractimpl, Bytes, BytesN, Env};

#[contract]
pub struct SigCheckContract;

#[contractimpl]
impl SigCheckContract {
    /// Panics unless `signature` is a valid Ed25519 signature over `message`.
    ///
    /// Returning `()` rather than `bool` is deliberate: the caller learns the
    /// answer from whether the invocation trapped, and a `bool` return would
    /// invite a caller to ignore it.
    pub fn verify(env: Env, public_key: BytesN<32>, message: Bytes, signature: BytesN<64>) {
        env.crypto().ed25519_verify(&public_key, &message, &signature);
    }
}

#[cfg(test)]
mod test;
