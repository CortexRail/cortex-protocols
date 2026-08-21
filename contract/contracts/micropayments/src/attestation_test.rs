//! Tests for proof-of-execution attestation.
//!
//! The suite is built around one scenario — a seller commits a batch of signed
//! calls and a buyer tries to break it — exercised from both sides: honest
//! batches must survive every challenge, and dishonest ones must lose exactly
//! the right amount of money.
//!
//! Signing happens with ed25519-dalek rather than through soroban's testutils
//! because the interesting cases need signatures that are *wrong* in specific
//! ways: signed by the wrong key, over the wrong bytes, or absent entirely.

extern crate alloc;

use super::*;
use crate::attestation::{batch_message, hash_internal, leaf_hash, leaf_message};
use alloc::vec::Vec as StdVec;
use ed25519_dalek::{Signer, SigningKey};
use soroban_sdk::{
    testutils::{Address as _, Ledger, LedgerInfo},
    token, Address, Bytes, BytesN, Env, Vec,
};

const PRICE: i128 = 1_000;

// ── Harness ──────────────────────────────────────────────────────────────────

struct Fixture {
    env: Env,
    client: MicropaymentsContractClient<'static>,
    buyer: Address,
    seller: Address,
    signing_key: SigningKey,
    stream_id: u64,
}

fn to_vec(bytes: &Bytes) -> StdVec<u8> {
    bytes.iter().collect()
}

/// A deterministic Ed25519 key. Fixed seeds keep failures reproducible.
fn signing_key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn public_key(env: &Env, key: &SigningKey) -> BytesN<32> {
    BytesN::from_array(env, &key.verifying_key().to_bytes())
}

fn sign(env: &Env, key: &SigningKey, message: &Bytes) -> BytesN<64> {
    BytesN::from_array(env, &key.sign(&to_vec(message)).to_bytes())
}

/// A funded stream with a registered attestation key and an escrowed allowance.
fn setup(allowance_calls: u64) -> Fixture {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(MicropaymentsContract, ());
    let client = MicropaymentsContractClient::new(&env, &contract_id);

    // The signature checker has to exist before any challenge can be resolved.
    let checker = env.register(sig_check::SigCheckContract, ());
    client.set_sig_checker(&checker);

    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let token_contract = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_address = token_contract.address();
    token::StellarAssetClient::new(&env, &token_address).mint(&buyer, &100_000_000);

    let stream_id = client.open_stream(&buyer, &seller, &token_address, &10_000_000, &100, &3600);

    let signing_key = signing_key(7);
    client.register_attestation_key(&seller, &public_key(&env, &signing_key));
    client.fund_usage_meter(&buyer, &stream_id, &PRICE, &((allowance_calls as i128) * PRICE));

    Fixture {
        env,
        client,
        buyer,
        seller,
        signing_key,
        stream_id,
    }
}

/// Build an attestation leaf, signed by `key` unless `key` is None.
///
/// A `None` key produces a leaf carrying a syntactically valid but meaningless
/// signature — the shape of a fabricated call the seller committed to without
/// ever having served it.
fn make_leaf(
    env: &Env,
    stream_id: u64,
    call_index: u64,
    nonce_seed: u8,
    key: Option<&SigningKey>,
) -> AttestationLeaf {
    let mut leaf = AttestationLeaf {
        stream_id,
        call_index,
        request_hash: BytesN::from_array(env, &[call_index as u8; 32]),
        response_hash: BytesN::from_array(env, &[(call_index as u8).wrapping_add(128); 32]),
        timestamp: 1_700_000_000 + call_index,
        nonce: BytesN::from_array(env, &[nonce_seed; 32]),
        signature: BytesN::from_array(env, &[0u8; 64]),
    };

    leaf.signature = match key {
        Some(k) => sign(env, k, &leaf_message(env, &leaf)),
        None => BytesN::from_array(env, &[0xABu8; 64]),
    };
    leaf
}

/// A run of honestly signed leaves starting at `first_call_index`.
fn honest_leaves(fx: &Fixture, first_call_index: u64, count: u64) -> StdVec<AttestationLeaf> {
    (0..count)
        .map(|i| {
            make_leaf(
                &fx.env,
                fx.stream_id,
                first_call_index + i,
                (first_call_index + i) as u8,
                Some(&fx.signing_key),
            )
        })
        .collect()
}

/// Merkle levels, leaves first. Mirrors MerkleBatchBuilder: odd tails pair with
/// themselves and children are ordered by byte value.
fn build_levels(env: &Env, leaves: &[AttestationLeaf]) -> StdVec<StdVec<BytesN<32>>> {
    let bottom: StdVec<BytesN<32>> = leaves.iter().map(|l| leaf_hash(env, l)).collect();
    let mut levels: StdVec<StdVec<BytesN<32>>> = StdVec::new();
    levels.push(bottom);

    while levels[levels.len() - 1].len() > 1 {
        let current = levels[levels.len() - 1].clone();
        let mut next: StdVec<BytesN<32>> = StdVec::new();
        let mut i = 0usize;
        while i < current.len() {
            let left = &current[i];
            let right = if i + 1 < current.len() { &current[i + 1] } else { left };
            next.push(hash_internal(env, left, right));
            i += 2;
        }
        levels.push(next);
    }
    levels
}

fn merkle_root(env: &Env, leaves: &[AttestationLeaf]) -> BytesN<32> {
    let levels = build_levels(env, leaves);
    levels[levels.len() - 1][0].clone()
}

fn merkle_proof(env: &Env, leaves: &[AttestationLeaf], position: usize) -> Vec<BytesN<32>> {
    let levels = build_levels(env, leaves);
    let mut proof: Vec<BytesN<32>> = Vec::new(env);
    let mut index = position;

    // Every level but the root contributes one sibling.
    for depth in 0..levels.len() - 1 {
        let level = &levels[depth];
        let sibling = if index % 2 == 1 { index - 1 } else { index + 1 };
        let node = if sibling < level.len() {
            level[sibling].clone()
        } else {
            // Odd tail: it was paired with itself.
            level[index].clone()
        };
        proof.push_back(node);
        index /= 2;
    }
    proof
}

/// Commit a batch on-chain and hand back its id.
fn record(fx: &Fixture, leaves: &[AttestationLeaf]) -> u64 {
    let root = merkle_root(&fx.env, leaves);
    let message = batch_message(&fx.env, fx.stream_id, &root, leaves.len() as u64);
    let signature = sign(&fx.env, &fx.signing_key, &message);

    fx.client.record_usage_batch(
        &fx.seller,
        &fx.stream_id,
        &root,
        &(leaves.len() as u64),
        &signature,
    )
}

fn advance_to(env: &Env, timestamp: u64) {
    env.ledger().set(LedgerInfo {
        timestamp,
        protocol_version: 22,
        sequence_number: 10,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: 16,
        min_persistent_entry_ttl: 100_000,
        max_entry_ttl: 6_312_000,
    });
}

// ── Registration and funding ─────────────────────────────────────────────────

#[test]
fn registers_the_sellers_attestation_key() {
    let fx = setup(10);
    let stored = fx.client.get_attestation_key(&fx.seller).unwrap();
    assert_eq!(stored, public_key(&fx.env, &fx.signing_key));
}

#[test]
fn funding_sets_the_call_allowance() {
    let fx = setup(10);

    let meter = fx.client.get_usage_meter(&fx.stream_id).unwrap();
    assert_eq!(meter.escrowed, 10 * PRICE);
    assert_eq!(meter.price_per_call, PRICE);
    assert_eq!(meter.next_call_index, 0);
    assert_eq!(fx.client.usage_calls_remaining(&fx.stream_id), 10);
}

#[test]
#[should_panic(expected = "price_per_call is fixed")]
fn a_top_up_cannot_reprice_calls() {
    let fx = setup(10);
    // Repricing mid-meter would silently change what already-attested but
    // not-yet-batched calls cost.
    fx.client
        .fund_usage_meter(&fx.buyer, &fx.stream_id, &(PRICE * 2), &(PRICE * 2));
}

// ── Recording ────────────────────────────────────────────────────────────────

#[test]
fn recording_a_batch_charges_exactly_call_count() {
    let fx = setup(50);
    let leaves = honest_leaves(&fx, 0, 20);

    let batch_id = record(&fx, &leaves);
    assert_eq!(batch_id, 1);

    let meter = fx.client.get_usage_meter(&fx.stream_id).unwrap();
    assert_eq!(meter.escrowed, 30 * PRICE, "20 of 50 calls consumed");
    assert_eq!(meter.charged, 20 * PRICE);
    assert_eq!(meter.next_call_index, 20);
    assert_eq!(fx.client.usage_calls_remaining(&fx.stream_id), 30);

    let batch = fx.client.get_usage_batch(&fx.stream_id, &batch_id).unwrap();
    assert_eq!(batch.call_count, 20);
    assert_eq!(batch.first_call_index, 0);
    assert_eq!(batch.charged, 20 * PRICE);
    assert_eq!(batch.status, BatchStatus::Recorded);
}

#[test]
fn consecutive_batches_continue_the_index_run() {
    let fx = setup(50);
    record(&fx, &honest_leaves(&fx, 0, 5));
    let second = record(&fx, &honest_leaves(&fx, 5, 7));

    let batch = fx.client.get_usage_batch(&fx.stream_id, &second).unwrap();
    assert_eq!(batch.first_call_index, 5);
    assert_eq!(batch.call_count, 7);
    assert_eq!(
        fx.client.get_usage_meter(&fx.stream_id).unwrap().next_call_index,
        12
    );
}

#[test]
#[should_panic]
fn a_forged_batch_signature_cannot_be_recorded() {
    let fx = setup(50);
    let leaves = honest_leaves(&fx, 0, 4);
    let root = merkle_root(&fx.env, &leaves);

    // Signed by a key the seller never registered.
    let impostor = signing_key(99);
    let signature = sign(
        &fx.env,
        &impostor,
        &batch_message(&fx.env, fx.stream_id, &root, 4),
    );

    fx.client
        .record_usage_batch(&fx.seller, &fx.stream_id, &root, &4, &signature);
}

#[test]
#[should_panic]
fn a_batch_signature_over_a_different_call_count_is_rejected() {
    let fx = setup(50);
    let leaves = honest_leaves(&fx, 0, 4);
    let root = merkle_root(&fx.env, &leaves);

    // Sign for 4 calls, then try to charge for 40. The count is inside the
    // signed bytes precisely so this fails.
    let signature = sign(
        &fx.env,
        &fx.signing_key,
        &batch_message(&fx.env, fx.stream_id, &root, 4),
    );

    fx.client
        .record_usage_batch(&fx.seller, &fx.stream_id, &root, &40, &signature);
}

#[test]
#[should_panic(expected = "usage allowance exhausted")]
fn a_batch_larger_than_the_allowance_is_rejected() {
    let fx = setup(5);
    record(&fx, &honest_leaves(&fx, 0, 6));
}

// ── Merkle proofs ────────────────────────────────────────────────────────────

#[test]
fn every_leaf_in_a_batch_verifies_against_the_committed_root() {
    // Sizes chosen to cover a perfect tree, both odd-tail shapes, and a
    // single-leaf tree with an empty proof.
    for count in [1u64, 2, 3, 5, 8, 11] {
        let fx = setup(200);
        let leaves = honest_leaves(&fx, 0, count);
        let batch_id = record(&fx, &leaves);

        for (position, leaf) in leaves.iter().enumerate() {
            let proof = merkle_proof(&fx.env, &leaves, position);
            assert!(
                fx.client
                    .verify_usage_proof(&fx.stream_id, &batch_id, leaf, &proof),
                "leaf {position} of {count} failed to verify"
            );
        }
    }
}

#[test]
fn a_leaf_that_was_never_committed_fails_to_verify() {
    let fx = setup(50);
    let leaves = honest_leaves(&fx, 0, 8);
    let batch_id = record(&fx, &leaves);

    // A properly signed leaf that simply is not in this batch, presented with
    // another leaf's proof.
    let outsider = make_leaf(&fx.env, fx.stream_id, 3, 200, Some(&fx.signing_key));
    let proof = merkle_proof(&fx.env, &leaves, 3);

    assert!(!fx
        .client
        .verify_usage_proof(&fx.stream_id, &batch_id, &outsider, &proof));
}

// ── Challenges: forged attestations ──────────────────────────────────────────

#[test]
fn a_forged_attestation_voids_the_batch_suffix() {
    let fx = setup(50);

    // 10 calls, of which the seller fabricated the one at index 6.
    let mut leaves = honest_leaves(&fx, 0, 10);
    leaves[6] = make_leaf(&fx.env, fx.stream_id, 6, 6, None);
    let batch_id = record(&fx, &leaves);

    let proof = merkle_proof(&fx.env, &leaves, 6);
    let voided = fx.client.challenge_usage_batch(
        &fx.buyer,
        &fx.stream_id,
        &batch_id,
        &leaves[6],
        &proof,
    );

    // Positions 6..9 inclusive — the forged call and everything numbered after
    // it — are reversed. Positions 0..5 were honestly attested and still stand.
    assert_eq!(voided, 4);

    let batch = fx.client.get_usage_batch(&fx.stream_id, &batch_id).unwrap();
    assert_eq!(batch.voided_calls, 4);
    assert_eq!(batch.refunded, 4 * PRICE);
    assert_eq!(batch.status, BatchStatus::Challenged);
}

#[test]
fn a_forgery_at_the_first_call_voids_the_whole_batch() {
    let fx = setup(50);
    let mut leaves = honest_leaves(&fx, 0, 10);
    leaves[0] = make_leaf(&fx.env, fx.stream_id, 0, 0, None);
    let batch_id = record(&fx, &leaves);

    let proof = merkle_proof(&fx.env, &leaves, 0);
    let voided =
        fx.client
            .challenge_usage_batch(&fx.buyer, &fx.stream_id, &batch_id, &leaves[0], &proof);

    assert_eq!(voided, 10);
    let batch = fx.client.get_usage_batch(&fx.stream_id, &batch_id).unwrap();
    assert_eq!(batch.status, BatchStatus::Voided);
    assert_eq!(batch.refunded, batch.charged);
}

#[test]
fn voided_funds_return_to_the_buyers_allowance() {
    let fx = setup(50);
    let mut leaves = honest_leaves(&fx, 0, 10);
    leaves[6] = make_leaf(&fx.env, fx.stream_id, 6, 6, None);
    let batch_id = record(&fx, &leaves);

    let after_record = fx.client.get_usage_meter(&fx.stream_id).unwrap();
    assert_eq!(after_record.escrowed, 40 * PRICE);
    assert_eq!(after_record.charged, 10 * PRICE);

    let proof = merkle_proof(&fx.env, &leaves, 6);
    fx.client
        .challenge_usage_batch(&fx.buyer, &fx.stream_id, &batch_id, &leaves[6], &proof);

    let after_void = fx.client.get_usage_meter(&fx.stream_id).unwrap();
    // The 4 voided calls move back out of the seller's column and into the
    // buyer's spendable allowance. Nothing is created or destroyed.
    assert_eq!(after_void.escrowed, 44 * PRICE);
    assert_eq!(after_void.charged, 6 * PRICE);
    assert_eq!(
        after_void.escrowed + after_void.charged,
        after_record.escrowed + after_record.charged
    );
}

#[test]
fn partial_void_arithmetic_holds_at_every_position() {
    // The refund is a pure function of where the forgery sits, so check the
    // whole range rather than one convenient case.
    for position in 0..8u64 {
        let fx = setup(100);
        let mut leaves = honest_leaves(&fx, 0, 8);
        leaves[position as usize] =
            make_leaf(&fx.env, fx.stream_id, position, position as u8, None);
        let batch_id = record(&fx, &leaves);

        let proof = merkle_proof(&fx.env, &leaves, position as usize);
        let voided = fx.client.challenge_usage_batch(
            &fx.buyer,
            &fx.stream_id,
            &batch_id,
            &leaves[position as usize],
            &proof,
        );

        let expected = 8 - position;
        assert_eq!(voided, expected, "forgery at position {position}");

        let meter = fx.client.get_usage_meter(&fx.stream_id).unwrap();
        assert_eq!(meter.charged, ((8 - expected) as i128) * PRICE);
        assert_eq!(meter.escrowed, (92 + expected as i128) * PRICE);
    }
}

#[test]
fn a_batch_offset_from_zero_prices_its_void_correctly() {
    // first_call_index is what turns a call_index into a position; a batch that
    // does not start at zero is where an off-by-one would show up.
    let fx = setup(100);
    record(&fx, &honest_leaves(&fx, 0, 12));

    let mut leaves = honest_leaves(&fx, 12, 6);
    leaves[4] = make_leaf(&fx.env, fx.stream_id, 16, 16, None);
    let batch_id = record(&fx, &leaves);

    let proof = merkle_proof(&fx.env, &leaves, 4);
    let voided =
        fx.client
            .challenge_usage_batch(&fx.buyer, &fx.stream_id, &batch_id, &leaves[4], &proof);

    // call_index 16 sits at position 16 - 12 = 4 in a 6-call batch.
    assert_eq!(voided, 2);
}

#[test]
#[should_panic(expected = "attestation is validly signed")]
fn challenging_an_honest_attestation_fails() {
    let fx = setup(50);
    let leaves = honest_leaves(&fx, 0, 6);
    let batch_id = record(&fx, &leaves);

    let proof = merkle_proof(&fx.env, &leaves, 2);
    fx.client
        .challenge_usage_batch(&fx.buyer, &fx.stream_id, &batch_id, &leaves[2], &proof);
}

#[test]
#[should_panic(expected = "merkle proof does not reproduce")]
fn challenging_with_a_leaf_outside_the_batch_fails() {
    let fx = setup(50);
    let leaves = honest_leaves(&fx, 0, 6);
    let batch_id = record(&fx, &leaves);

    // An unsigned leaf the seller never committed. Without the proof check a
    // buyer could void any batch by inventing a bad leaf out of nothing.
    let invented = make_leaf(&fx.env, fx.stream_id, 2, 250, None);
    let proof = merkle_proof(&fx.env, &leaves, 2);

    fx.client
        .challenge_usage_batch(&fx.buyer, &fx.stream_id, &batch_id, &invented, &proof);
}

#[test]
#[should_panic(expected = "already covered by an earlier successful challenge")]
fn a_second_challenge_cannot_shrink_the_voided_suffix() {
    let fx = setup(50);
    let mut leaves = honest_leaves(&fx, 0, 10);
    leaves[3] = make_leaf(&fx.env, fx.stream_id, 3, 3, None);
    leaves[7] = make_leaf(&fx.env, fx.stream_id, 7, 7, None);
    let batch_id = record(&fx, &leaves);

    // Voiding from position 3 already covers position 7.
    fx.client.challenge_usage_batch(
        &fx.buyer,
        &fx.stream_id,
        &batch_id,
        &leaves[3],
        &merkle_proof(&fx.env, &leaves, 3),
    );
    fx.client.challenge_usage_batch(
        &fx.buyer,
        &fx.stream_id,
        &batch_id,
        &leaves[7],
        &merkle_proof(&fx.env, &leaves, 7),
    );
}

#[test]
fn a_second_challenge_further_back_refunds_only_the_difference() {
    let fx = setup(50);
    let mut leaves = honest_leaves(&fx, 0, 10);
    leaves[3] = make_leaf(&fx.env, fx.stream_id, 3, 3, None);
    leaves[7] = make_leaf(&fx.env, fx.stream_id, 7, 7, None);
    let batch_id = record(&fx, &leaves);

    let first = fx.client.challenge_usage_batch(
        &fx.buyer,
        &fx.stream_id,
        &batch_id,
        &leaves[7],
        &merkle_proof(&fx.env, &leaves, 7),
    );
    assert_eq!(first, 3, "positions 7..9");

    let second = fx.client.challenge_usage_batch(
        &fx.buyer,
        &fx.stream_id,
        &batch_id,
        &leaves[3],
        &merkle_proof(&fx.env, &leaves, 3),
    );
    assert_eq!(second, 4, "positions 3..6, the ones not already voided");

    let batch = fx.client.get_usage_batch(&fx.stream_id, &batch_id).unwrap();
    assert_eq!(batch.voided_calls, 7);
    // 7 calls refunded in total, never 10 — the batch cannot over-refund.
    assert_eq!(batch.refunded, 7 * PRICE);
    assert!(batch.refunded < batch.charged);
}

// ── Challenges: replayed nonces ──────────────────────────────────────────────

#[test]
fn a_nonce_replayed_across_two_batches_is_voided() {
    let fx = setup(50);

    let first_leaves = honest_leaves(&fx, 0, 4);
    let first_batch = record(&fx, &first_leaves);

    // The seller re-serves call 0's nonce as a "new" call at index 5. Both
    // leaves are honestly signed; the fraud is the repetition itself.
    let mut second_leaves = honest_leaves(&fx, 4, 4);
    second_leaves[1] = make_leaf(&fx.env, fx.stream_id, 5, 0, Some(&fx.signing_key));
    let second_batch = record(&fx, &second_leaves);

    let voided = fx.client.challenge_nonce_replay(
        &fx.buyer,
        &fx.stream_id,
        &first_batch,
        &first_leaves[0],
        &merkle_proof(&fx.env, &first_leaves, 0),
        &second_batch,
        &second_leaves[1],
        &merkle_proof(&fx.env, &second_leaves, 1),
    );

    // The replay sits at position 1 of a 4-call batch, so 3 calls reverse.
    assert_eq!(voided, 3);

    let batch = fx.client.get_usage_batch(&fx.stream_id, &second_batch).unwrap();
    assert_eq!(batch.refunded, 3 * PRICE);
    // The original batch is untouched: it did nothing wrong.
    let untouched = fx.client.get_usage_batch(&fx.stream_id, &first_batch).unwrap();
    assert_eq!(untouched.voided_calls, 0);
    assert_eq!(untouched.status, BatchStatus::Recorded);
}

#[test]
#[should_panic(expected = "do not share a nonce")]
fn a_replay_claim_over_two_distinct_nonces_is_rejected() {
    let fx = setup(50);
    let first_leaves = honest_leaves(&fx, 0, 4);
    let first_batch = record(&fx, &first_leaves);
    let second_leaves = honest_leaves(&fx, 4, 4);
    let second_batch = record(&fx, &second_leaves);

    fx.client.challenge_nonce_replay(
        &fx.buyer,
        &fx.stream_id,
        &first_batch,
        &first_leaves[0],
        &merkle_proof(&fx.env, &first_leaves, 0),
        &second_batch,
        &second_leaves[1],
        &merkle_proof(&fx.env, &second_leaves, 1),
    );
}

#[test]
#[should_panic(expected = "not committed in its batch")]
fn a_replay_claim_needs_both_leaves_committed() {
    let fx = setup(50);
    let first_leaves = honest_leaves(&fx, 0, 4);
    let first_batch = record(&fx, &first_leaves);
    let second_leaves = honest_leaves(&fx, 4, 4);
    let second_batch = record(&fx, &second_leaves);

    // A fabricated "original" sharing the replayed leaf's nonce. Without the
    // proof requirement this would void an honest batch.
    let invented = make_leaf(&fx.env, fx.stream_id, 1, 5, Some(&fx.signing_key));

    fx.client.challenge_nonce_replay(
        &fx.buyer,
        &fx.stream_id,
        &first_batch,
        &invented,
        &merkle_proof(&fx.env, &first_leaves, 1),
        &second_batch,
        &second_leaves[1],
        &merkle_proof(&fx.env, &second_leaves, 1),
    );
}

// ── Claiming ─────────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "challenge window is still open")]
fn a_seller_cannot_claim_inside_the_challenge_window() {
    let fx = setup(50);
    let batch_id = record(&fx, &honest_leaves(&fx, 0, 5));
    fx.client.claim_usage_batch(&fx.seller, &fx.stream_id, &batch_id);
}

#[test]
fn a_seller_claims_the_batch_net_of_refunds_once_the_window_closes() {
    let fx = setup(50);
    let mut leaves = honest_leaves(&fx, 0, 10);
    leaves[6] = make_leaf(&fx.env, fx.stream_id, 6, 6, None);
    let batch_id = record(&fx, &leaves);

    fx.client.challenge_usage_batch(
        &fx.buyer,
        &fx.stream_id,
        &batch_id,
        &leaves[6],
        &merkle_proof(&fx.env, &leaves, 6),
    );

    advance_to(&fx.env, CHALLENGE_WINDOW_SECS + 1);
    let paid = fx.client.claim_usage_batch(&fx.seller, &fx.stream_id, &batch_id);

    // 10 charged, 4 voided, 6 paid.
    assert_eq!(paid, 6 * PRICE);
    let batch = fx.client.get_usage_batch(&fx.stream_id, &batch_id).unwrap();
    assert_eq!(batch.status, BatchStatus::Claimed);
}

#[test]
#[should_panic(expected = "challenge window has closed")]
fn a_claimed_batch_can_no_longer_be_challenged() {
    let fx = setup(50);
    let mut leaves = honest_leaves(&fx, 0, 6);
    leaves[2] = make_leaf(&fx.env, fx.stream_id, 2, 2, None);
    let batch_id = record(&fx, &leaves);

    advance_to(&fx.env, CHALLENGE_WINDOW_SECS + 1);
    fx.client.claim_usage_batch(&fx.seller, &fx.stream_id, &batch_id);

    fx.client.challenge_usage_batch(
        &fx.buyer,
        &fx.stream_id,
        &batch_id,
        &leaves[2],
        &merkle_proof(&fx.env, &leaves, 2),
    );
}

#[test]
fn unspent_allowance_returns_to_the_buyer() {
    let fx = setup(50);
    record(&fx, &honest_leaves(&fx, 0, 10));

    let remaining = fx.client.withdraw_usage_escrow(&fx.buyer, &fx.stream_id, &(40 * PRICE));
    assert_eq!(remaining, 0);
    assert_eq!(fx.client.usage_calls_remaining(&fx.stream_id), 0);
}

#[test]
#[should_panic(expected = "insufficient unspent allowance")]
fn a_buyer_cannot_withdraw_money_already_charged() {
    let fx = setup(50);
    record(&fx, &honest_leaves(&fx, 0, 10));
    // 10 calls' worth is charged and sitting in the seller's column.
    fx.client
        .withdraw_usage_escrow(&fx.buyer, &fx.stream_id, &(50 * PRICE));
}

// ── Cross-language wire compatibility ────────────────────────────────────────

/// Pinned vectors shared with `backend/src/attestation/__tests__`.
///
/// The whole scheme rests on the contract and the Node encoder producing
/// identical bytes: a one-byte disagreement means every on-chain proof silently
/// stops verifying while both sides still look internally consistent. These
/// constants were produced by canonical.js and are asserted from both
/// languages, so a change to either encoder fails a test instead of shipping.
const VECTOR_LEAF_HASH: [u8; 32] = [
    0xb4, 0xc1, 0x33, 0x0b, 0xdb, 0xc4, 0x83, 0x25, 0xbd, 0xa5, 0x53, 0x96, 0x52, 0xc3, 0x97, 0x93,
    0xf3, 0xe7, 0xf4, 0x1d, 0x8d, 0x45, 0x4d, 0xd8, 0x77, 0x33, 0xad, 0xbf, 0x3e, 0xe0, 0x4d, 0x4c,
];

const VECTOR_INTERNAL_HASH: [u8; 32] = [
    0x7b, 0xc0, 0x01, 0x03, 0xde, 0x12, 0x06, 0xe4, 0x94, 0x88, 0x08, 0xb1, 0x2b, 0xd2, 0x01, 0x6b,
    0x69, 0x23, 0x25, 0x8e, 0x43, 0xb9, 0xc2, 0x37, 0x24, 0xed, 0x10, 0x4c, 0xfd, 0xd1, 0xfd, 0xea,
];

#[test]
fn leaf_hashing_matches_the_javascript_encoder() {
    let env = Env::default();
    let leaf = AttestationLeaf {
        stream_id: 42,
        call_index: 7,
        request_hash: BytesN::from_array(&env, &[0x07; 32]),
        response_hash: BytesN::from_array(&env, &[0x87; 32]),
        timestamp: 1_700_000_007,
        nonce: BytesN::from_array(&env, &[0x07; 32]),
        signature: BytesN::from_array(&env, &[0u8; 64]),
    };

    // The 120-byte preimage plus its one-byte domain tag.
    assert_eq!(leaf_message(&env, &leaf).len(), 121);
    assert_eq!(leaf_hash(&env, &leaf).to_array(), VECTOR_LEAF_HASH);
}

#[test]
fn internal_hashing_is_order_independent_and_matches_javascript() {
    let env = Env::default();
    let a = BytesN::from_array(&env, &[0xAA; 32]);
    let b = BytesN::from_array(&env, &[0x11; 32]);

    // Sorted children: swapping the arguments must not move the root, which is
    // what lets a proof travel as a bare list of siblings.
    assert_eq!(hash_internal(&env, &a, &b), hash_internal(&env, &b, &a));
    assert_eq!(hash_internal(&env, &a, &b).to_array(), VECTOR_INTERNAL_HASH);
}

#[test]
fn batch_commitment_bytes_match_the_javascript_encoder() {
    let env = Env::default();
    let root = BytesN::from_array(&env, &[0xAB; 32]);
    let message = batch_message(&env, 42, &root, 20);

    // 0x02 || stream_id(8) || root(32) || call_count(8)
    assert_eq!(message.len(), 49);
    let bytes: StdVec<u8> = message.iter().collect();
    assert_eq!(bytes[0], 0x02);
    assert_eq!(&bytes[1..9], &42u64.to_be_bytes());
    assert_eq!(&bytes[9..41], &[0xABu8; 32]);
    assert_eq!(&bytes[41..49], &20u64.to_be_bytes());
}
