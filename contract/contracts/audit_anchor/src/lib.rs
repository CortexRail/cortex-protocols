#![no_std]

//! Audit Anchor contract for Cortex Protocol.
//!
//! Provides an append-only on-chain registry of Merkle roots computed over
//! off-chain audit log segments. Each root is keyed by the sequential anchor
//! index and records the submitting admin, the 32-byte Merkle root, and the
//! number of audit log entries covered. Once anchored a root is immutable —
//! there is no function to overwrite or delete an existing anchor record,
//! so the on-chain state is an independently-verifiable commitment to the
//! off-chain audit trail.
//!
//! # Access control
//! Only the address stored in `ADMIN` storage may call `anchor_root`.
//! A single admin is set at initialisation time; the owner may rotate it
//! via `set_admin`.
//!
//! # Anchor invariant
//! `anchor_count` is incremented atomically with each insertion.
//! Clients must never observe a gap in the sequence.

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, BytesN, Env, Symbol, Vec,
};

// ── Storage keys ─────────────────────────────────────────────────────────────

const ADMIN: Symbol = symbol_short!("ADMIN");
/// Number of anchors stored (also the next free index).
const ANCHOR_CNT: Symbol = symbol_short!("ANC_CNT");

// ── Data types ────────────────────────────────────────────────────────────────

/// A single Merkle-root commitment stored on-chain.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AnchorRecord {
    /// Zero-based sequential index of this anchor.
    pub index: u32,
    /// Address of the admin who submitted this anchor.
    pub submitted_by: Address,
    /// 32-byte Merkle root over the covered audit-log segment.
    pub root: BytesN<32>,
    /// Total audit-log entries included up to and including this anchor.
    pub entry_count: u64,
    /// Ledger timestamp when the anchor was committed.
    pub anchored_at: u64,
}

/// Derive the storage key for anchor record `index`.
fn anchor_key(index: u32) -> (Symbol, u32) {
    (symbol_short!("ANC"), index)
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct AuditAnchorContract;

#[contractimpl]
impl AuditAnchorContract {
    // ── Lifecycle ─────────────────────────────────────────────────────────

    /// Initialise the contract; caller becomes the sole admin.
    /// Panics if already initialised (idempotent protection).
    pub fn initialize(env: Env, admin: Address) {
        admin.require_auth();
        assert!(
            env.storage().instance().get::<Symbol, Address>(&ADMIN).is_none(),
            "contract already initialized"
        );
        env.storage().instance().set(&ADMIN, &admin);
        env.storage().instance().set(&ANCHOR_CNT, &0u32);
    }

    /// Replace the admin address. Current admin must authorise.
    pub fn set_admin(env: Env, current_admin: Address, new_admin: Address) {
        current_admin.require_auth();
        let stored: Address = env
            .storage()
            .instance()
            .get(&ADMIN)
            .expect("contract not initialized");
        assert!(stored == current_admin, "caller is not the admin");
        env.storage().instance().set(&ADMIN, &new_admin);

        env.events().publish(
            (symbol_short!("ADMIN_CHG"),),
            (current_admin, new_admin),
        );
    }

    // ── Anchoring ─────────────────────────────────────────────────────────

    /// Append a new Merkle root commitment.
    ///
    /// Only the configured admin may call this. The `entry_count` must be
    /// strictly greater than the previous anchor's `entry_count` so that
    /// anchors always cover a non-empty forward segment.
    ///
    /// # Panics
    /// - Contract not initialised.
    /// - Caller is not the admin.
    /// - `entry_count` ≤ previous anchor's `entry_count`.
    pub fn anchor_root(
        env: Env,
        admin: Address,
        root: BytesN<32>,
        entry_count: u64,
    ) -> AnchorRecord {
        admin.require_auth();

        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN)
            .expect("contract not initialized");
        assert!(stored_admin == admin, "caller is not the admin");

        let index: u32 = env
            .storage()
            .instance()
            .get(&ANCHOR_CNT)
            .unwrap_or(0u32);

        // Enforce strictly increasing entry_count to prevent re-anchoring
        // the same log segment and to guarantee anchors cover distinct ranges.
        if index > 0 {
            let prev: AnchorRecord = env
                .storage()
                .persistent()
                .get(&anchor_key(index - 1))
                .expect("previous anchor missing");
            assert!(
                entry_count > prev.entry_count,
                "entry_count must exceed the previous anchor's entry_count"
            );
        }

        let record = AnchorRecord {
            index,
            submitted_by: admin.clone(),
            root: root.clone(),
            entry_count,
            anchored_at: env.ledger().timestamp(),
        };

        env.storage()
            .persistent()
            .set(&anchor_key(index), &record);

        let next_index = index + 1;
        env.storage().instance().set(&ANCHOR_CNT, &next_index);

        env.events().publish(
            (symbol_short!("ROOT_ANC"), admin),
            (index, root, entry_count),
        );

        record
    }

    // ── Views ─────────────────────────────────────────────────────────────

    /// Total number of committed anchors.
    pub fn anchor_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&ANCHOR_CNT)
            .unwrap_or(0u32)
    }

    /// Retrieve a single anchor record by its zero-based index.
    pub fn get_anchor(env: Env, index: u32) -> Option<AnchorRecord> {
        env.storage().persistent().get(&anchor_key(index))
    }

    /// Return a slice of anchor records `[from, to)` (exclusive upper bound).
    ///
    /// At most 100 records are returned per call to bound response size.
    /// If `to` exceeds the total anchor count the response is clamped.
    pub fn get_anchors(env: Env, from: u32, to: u32) -> Vec<AnchorRecord> {
        let count: u32 = env
            .storage()
            .instance()
            .get(&ANCHOR_CNT)
            .unwrap_or(0u32);

        let end = if to > count { count } else { to };
        let max_end = if end > from + 100 { from + 100 } else { end };

        let mut results = Vec::new(&env);
        let mut i = from;
        while i < max_end {
            if let Some(record) = env.storage().persistent().get(&anchor_key(i)) {
                results.push_back(record);
            }
            i += 1;
        }
        results
    }

    /// The most recent anchor, or `None` if none have been committed.
    pub fn latest_anchor(env: Env) -> Option<AnchorRecord> {
        let count: u32 = env
            .storage()
            .instance()
            .get(&ANCHOR_CNT)
            .unwrap_or(0u32);
        if count == 0 {
            return None;
        }
        env.storage().persistent().get(&anchor_key(count - 1))
    }

    /// Current admin address.
    pub fn get_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&ADMIN)
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod test {
    extern crate std;
    use super::*;
    use soroban_sdk::{testutils::Address as _, Bytes, BytesN, Env};

    fn fresh() -> (Env, Address, AuditAnchorContractClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, AuditAnchorContract);
        let client = AuditAnchorContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        (env, admin, client)
    }

    fn root32(env: &Env, seed: u8) -> BytesN<32> {
        let mut b = [0u8; 32];
        b[0] = seed;
        BytesN::from_array(env, &b)
    }

    #[test]
    fn test_anchor_appends_and_retrieves() {
        let (env, admin, client) = fresh();

        let r = client.anchor_root(&admin, &root32(&env, 1), &1000u64);
        assert_eq!(r.index, 0);
        assert_eq!(r.entry_count, 1000);
        assert_eq!(client.anchor_count(), 1);

        let r2 = client.anchor_root(&admin, &root32(&env, 2), &2000u64);
        assert_eq!(r2.index, 1);
        assert_eq!(r2.entry_count, 2000);
        assert_eq!(client.anchor_count(), 2);

        let fetched = client.get_anchor(&0u32).unwrap();
        assert_eq!(fetched.root, root32(&env, 1));
    }

    #[test]
    #[should_panic(expected = "entry_count must exceed")]
    fn test_anchor_rejects_non_increasing_entry_count() {
        let (env, admin, client) = fresh();
        client.anchor_root(&admin, &root32(&env, 1), &1000u64);
        // Same entry_count should panic.
        client.anchor_root(&admin, &root32(&env, 2), &1000u64);
    }

    #[test]
    #[should_panic(expected = "caller is not the admin")]
    fn test_unauthorized_anchor_rejected() {
        let (env, _admin, client) = fresh();
        let rogue = Address::generate(&env);
        client.anchor_root(&rogue, &root32(&env, 1), &500u64);
    }

    #[test]
    fn test_get_anchors_range() {
        let (env, admin, client) = fresh();
        for i in 0u8..5 {
            client.anchor_root(&admin, &root32(&env, i + 1), &((i as u64 + 1) * 100));
        }
        let slice = client.get_anchors(&1u32, &4u32);
        assert_eq!(slice.len(), 3); // indices 1, 2, 3
        assert_eq!(slice.get(0).unwrap().index, 1);
    }

    #[test]
    fn test_latest_anchor() {
        let (env, admin, client) = fresh();
        assert!(client.latest_anchor().is_none());
        client.anchor_root(&admin, &root32(&env, 1), &100u64);
        client.anchor_root(&admin, &root32(&env, 2), &200u64);
        assert_eq!(client.latest_anchor().unwrap().entry_count, 200);
    }

    #[test]
    fn test_double_initialize_panics() {
        let (env, admin, client) = fresh();
        let _ = env; // keep env alive
        // second initialize should panic
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.initialize(&admin);
        }));
        assert!(result.is_err());
    }
}
