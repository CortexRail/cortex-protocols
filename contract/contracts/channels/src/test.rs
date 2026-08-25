//! Tests for the bidirectional payment channel contract.
//!
//! Built around the same adversarial shape as attestation_test.rs: every
//! happy path must survive, and every dishonest attempt — a stale close, a
//! forged signature, a revoked state republished, a race between two
//! unilateral closes — must lose exactly the right amount of money.

extern crate alloc;

use super::*;
use crate::state::signing_message;
use alloc::vec::Vec as StdVec;
use ed25519_dalek::{Signer, SigningKey};
use soroban_sdk::{
    testutils::{Address as _, Ledger, LedgerInfo},
    token, Address, Bytes, BytesN, Env,
};

// ── Harness ──────────────────────────────────────────────────────────────────

struct Fixture {
    env: Env,
    client: ChannelsContractClient<'static>,
    party_a: Address,
    party_b: Address,
    key_a: SigningKey,
    key_b: SigningKey,
    token: Address,
    channel_id: u64,
}

fn to_vec(bytes: &Bytes) -> StdVec<u8> {
    bytes.iter().collect()
}

fn signing_key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn public_key(env: &Env, key: &SigningKey) -> BytesN<32> {
    BytesN::from_array(env, &key.verifying_key().to_bytes())
}

fn sign(env: &Env, key: &SigningKey, message: &Bytes) -> BytesN<64> {
    BytesN::from_array(env, &key.sign(&to_vec(message)).to_bytes())
}

fn secret_of(seed: u8) -> [u8; 32] {
    [seed; 32]
}

fn commitment_of(env: &Env, secret: &[u8; 32]) -> BytesN<32> {
    env.crypto().sha256(&Bytes::from_array(env, secret)).into()
}

/// Build a fully dual-signed state, plus the two raw revocation secrets it
/// commits to (so a test can later reveal one to `punish`).
#[allow(clippy::too_many_arguments)]
fn make_state(
    fx: &Fixture,
    version: u64,
    balance_a: u64,
    balance_b: u64,
    seed_a: u8,
    seed_b: u8,
) -> (ChannelState, [u8; 32], [u8; 32]) {
    let secret_a = secret_of(seed_a);
    let secret_b = secret_of(seed_b);

    let mut state = ChannelState {
        channel_id: fx.channel_id,
        version,
        balance_a,
        balance_b,
        revocation_commit_a: commitment_of(&fx.env, &secret_a),
        revocation_commit_b: commitment_of(&fx.env, &secret_b),
        sig_a: BytesN::from_array(&fx.env, &[0u8; 64]),
        sig_b: BytesN::from_array(&fx.env, &[0u8; 64]),
    };
    let message = signing_message(&fx.env, &state);
    state.sig_a = sign(&fx.env, &fx.key_a, &message);
    state.sig_b = sign(&fx.env, &fx.key_b, &message);
    (state, secret_a, secret_b)
}

fn token_balance(env: &Env, token: &Address, who: &Address) -> i128 {
    token::Client::new(env, token).balance(who)
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

fn setup(deposit_a: i128, deposit_b: i128) -> Fixture {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(ChannelsContract, ());
    let client = ChannelsContractClient::new(&env, &contract_id);

    let party_a = Address::generate(&env);
    let party_b = Address::generate(&env);
    let key_a = signing_key(11);
    let key_b = signing_key(22);
    client.register_channel_key(&party_a, &public_key(&env, &key_a));
    client.register_channel_key(&party_b, &public_key(&env, &key_b));

    let token_admin = Address::generate(&env);
    let token_contract = env.register_stellar_asset_contract_v2(token_admin);
    let token = token_contract.address();
    token::StellarAssetClient::new(&env, &token).mint(&party_a, &1_000_000_000);
    token::StellarAssetClient::new(&env, &token).mint(&party_b, &1_000_000_000);

    let channel_id = client.open_channel(&party_a, &party_b, &token, &deposit_a, &deposit_b);

    Fixture {
        env,
        client,
        party_a,
        party_b,
        key_a,
        key_b,
        token,
        channel_id,
    }
}

// ── Opening ──────────────────────────────────────────────────────────────────

#[test]
fn opening_a_channel_escrows_both_deposits() {
    let fx = setup(600, 400);
    let contract_id = fx.client.address.clone();

    assert_eq!(token_balance(&fx.env, &fx.token, &contract_id), 1000);
    let channel = fx.client.get_channel(&fx.channel_id).unwrap();
    assert_eq!(channel.deposit_a, 600);
    assert_eq!(channel.deposit_b, 400);
    assert_eq!(channel.status, ChannelStatus::Open);
}

#[test]
fn opening_requires_both_parties_to_have_registered_a_key() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(ChannelsContract, ());
    let client = ChannelsContractClient::new(&env, &contract_id);

    let a = Address::generate(&env);
    let b = Address::generate(&env);
    client.register_channel_key(&a, &public_key(&env, &signing_key(1)));
    // b never registers.

    let token_admin = Address::generate(&env);
    let token = env
        .register_stellar_asset_contract_v2(token_admin)
        .address();
    token::StellarAssetClient::new(&env, &token).mint(&a, &1000);
    token::StellarAssetClient::new(&env, &token).mint(&b, &1000);

    let result = client.try_open_channel(&a, &b, &token, &600, &400);
    assert_eq!(
        result.unwrap_err().unwrap(),
        ChannelsError::ChannelKeyNotRegistered
    );
}

#[test]
fn opening_a_channel_with_yourself_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(ChannelsContract, ());
    let client = ChannelsContractClient::new(&env, &contract_id);

    let a = Address::generate(&env);
    client.register_channel_key(&a, &public_key(&env, &signing_key(1)));
    let token = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    token::StellarAssetClient::new(&env, &token).mint(&a, &1000);

    let result = client.try_open_channel(&a, &a, &token, &600, &400);
    assert_eq!(result.unwrap_err().unwrap(), ChannelsError::SelfChannel);
}

#[test]
fn opening_with_no_deposit_on_either_side_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(ChannelsContract, ());
    let client = ChannelsContractClient::new(&env, &contract_id);

    let a = Address::generate(&env);
    let b = Address::generate(&env);
    client.register_channel_key(&a, &public_key(&env, &signing_key(1)));
    client.register_channel_key(&b, &public_key(&env, &signing_key(2)));
    let token = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();

    let result = client.try_open_channel(&a, &b, &token, &0, &0);
    assert_eq!(result.unwrap_err().unwrap(), ChannelsError::InvalidDeposit);
}

// ── Cooperative close ────────────────────────────────────────────────────────

#[test]
fn cooperative_close_pays_both_parties_and_needs_no_window() {
    let fx = setup(600, 400);
    let (state, _, _) = make_state(&fx, 1, 550, 450, 1, 2);

    fx.client.close_cooperative(&fx.channel_id, &state);

    assert_eq!(
        token_balance(&fx.env, &fx.token, &fx.party_a),
        1_000_000_000 - 600 + 550
    );
    assert_eq!(
        token_balance(&fx.env, &fx.token, &fx.party_b),
        1_000_000_000 - 400 + 450
    );
    assert_eq!(
        fx.client.get_channel(&fx.channel_id).unwrap().status,
        ChannelStatus::Closed
    );
}

#[test]
fn cooperative_close_rejects_balances_that_do_not_conserve_the_deposit() {
    let fx = setup(600, 400);
    let (state, _, _) = make_state(&fx, 1, 550, 500, 1, 2); // sums to 1050, not 1000

    let result = fx.client.try_close_cooperative(&fx.channel_id, &state);
    assert_eq!(
        result.unwrap_err().unwrap(),
        ChannelsError::BalanceConservationViolated
    );
}

#[test]
#[should_panic]
fn cooperative_close_rejects_a_single_signer_state() {
    let fx = setup(600, 400);
    let (mut state, _, _) = make_state(&fx, 1, 550, 450, 1, 2);
    // Corrupt sig_b to something that never verifies under party_b's key.
    state.sig_b = BytesN::from_array(&fx.env, &[0xAB; 64]);

    fx.client.close_cooperative(&fx.channel_id, &state);
}

#[test]
fn cooperative_close_overrides_a_pending_unilateral_close() {
    let fx = setup(600, 400);
    let (stale, _, _) = make_state(&fx, 5, 600, 400, 1, 2);
    fx.client
        .close_unilateral(&fx.party_a, &fx.channel_id, &stale);

    let (agreed, _, _) = make_state(&fx, 6, 500, 500, 3, 4);
    fx.client.close_cooperative(&fx.channel_id, &agreed);

    assert_eq!(
        fx.client.get_channel(&fx.channel_id).unwrap().status,
        ChannelStatus::Closed
    );
    assert_eq!(
        token_balance(&fx.env, &fx.token, &fx.party_a),
        1_000_000_000 - 600 + 500
    );
}

// ── Unilateral close, uncontested ───────────────────────────────────────────

#[test]
fn a_stream_of_off_chain_updates_settles_at_the_final_balance_with_one_close() {
    // The acceptance criterion: unbounded off-chain updates, one on-chain
    // close. We don't literally submit 10,000 updates to the contract (only
    // the final one is ever posted) — that IS the point being tested.
    let fx = setup(1_000_000, 0);
    let mut version = 0u64;
    let mut balance_a = 1_000_000u64;
    let mut balance_b = 0u64;

    for _ in 0..500 {
        version += 1;
        balance_a -= 100;
        balance_b += 100;
    }

    let (final_state, _, _) = make_state(&fx, version, balance_a, balance_b, 7, 8);
    fx.client.close_cooperative(&fx.channel_id, &final_state);

    assert_eq!(
        token_balance(&fx.env, &fx.token, &fx.party_b),
        1_000_000_000 + 50_000
    );
    assert_eq!(
        token_balance(&fx.env, &fx.token, &fx.party_a),
        1_000_000_000 - 1_000_000 + 950_000
    );
}

#[test]
fn unilateral_close_starts_a_dispute_window_and_force_close_pays_the_pending_state() {
    let fx = setup(600, 400);
    let (state, _, _) = make_state(&fx, 3, 550, 450, 1, 2);
    fx.client
        .close_unilateral(&fx.party_a, &fx.channel_id, &state);

    assert_eq!(
        fx.client.get_channel(&fx.channel_id).unwrap().status,
        ChannelStatus::Closing
    );

    advance_to(&fx.env, DISPUTE_WINDOW_SECS + 1);
    fx.client.force_close(&fx.channel_id);

    assert_eq!(
        token_balance(&fx.env, &fx.token, &fx.party_a),
        1_000_000_000 - 600 + 550
    );
    assert_eq!(
        token_balance(&fx.env, &fx.token, &fx.party_b),
        1_000_000_000 - 400 + 450
    );
    assert_eq!(
        fx.client.get_channel(&fx.channel_id).unwrap().status,
        ChannelStatus::Closed
    );
}

#[test]
fn force_close_before_the_window_elapses_is_rejected() {
    let fx = setup(600, 400);
    let (state, _, _) = make_state(&fx, 3, 550, 450, 1, 2);
    fx.client
        .close_unilateral(&fx.party_a, &fx.channel_id, &state);

    let result = fx.client.try_force_close(&fx.channel_id);
    assert_eq!(
        result.unwrap_err().unwrap(),
        ChannelsError::DisputeWindowOpen
    );
}

#[test]
fn only_a_channel_party_may_start_a_unilateral_close() {
    let fx = setup(600, 400);
    let (state, _, _) = make_state(&fx, 1, 600, 400, 1, 2);
    let stranger = Address::generate(&fx.env);

    let result = fx
        .client
        .try_close_unilateral(&stranger, &fx.channel_id, &state);
    assert_eq!(result.unwrap_err().unwrap(), ChannelsError::NotAParty);
}

#[test]
#[should_panic]
fn a_forged_closing_state_cannot_start_the_dispute_window() {
    let fx = setup(600, 400);
    let (mut state, _, _) = make_state(&fx, 1, 600, 400, 1, 2);
    let impostor = signing_key(99);
    state.sig_a = sign(&fx.env, &impostor, &signing_message(&fx.env, &state));

    fx.client
        .close_unilateral(&fx.party_a, &fx.channel_id, &state);
}

// ── Dispute: a stale close superseded by a higher version ──────────────────

#[test]
fn a_stale_close_is_superseded_by_a_higher_version() {
    // The exact scenario from the issue: party A closes with version 40
    // while B holds version 87.
    let fx = setup(600, 400);
    let (stale, _, _) = make_state(&fx, 40, 600, 400, 1, 2);
    fx.client
        .close_unilateral(&fx.party_a, &fx.channel_id, &stale);

    let (later, _, _) = make_state(&fx, 87, 100, 900, 3, 4);
    fx.client.dispute(&fx.party_b, &fx.channel_id, &later);

    let pending = fx.client.get_pending_close(&fx.channel_id).unwrap();
    assert_eq!(pending.version, 87);
    assert_eq!(pending.balance_a, 100);
    assert_eq!(pending.balance_b, 900);

    advance_to(&fx.env, DISPUTE_WINDOW_SECS + 1);
    fx.client.force_close(&fx.channel_id);
    assert_eq!(
        token_balance(&fx.env, &fx.token, &fx.party_a),
        1_000_000_000 - 600 + 100
    );
    assert_eq!(
        token_balance(&fx.env, &fx.token, &fx.party_b),
        1_000_000_000 - 400 + 900
    );
}

#[test]
fn dispute_does_not_restart_the_window() {
    let fx = setup(600, 400);
    let (stale, _, _) = make_state(&fx, 1, 600, 400, 1, 2);
    fx.client
        .close_unilateral(&fx.party_a, &fx.channel_id, &stale);
    let original_deadline = fx
        .client
        .get_pending_close(&fx.channel_id)
        .unwrap()
        .dispute_deadline;

    advance_to(&fx.env, 100);
    let (later, _, _) = make_state(&fx, 2, 500, 500, 3, 4);
    fx.client.dispute(&fx.party_b, &fx.channel_id, &later);

    assert_eq!(
        fx.client
            .get_pending_close(&fx.channel_id)
            .unwrap()
            .dispute_deadline,
        original_deadline
    );
}

#[test]
fn a_dispute_after_the_window_would_have_expired_still_lands_if_nobody_force_closed() {
    // "Dispute after window expiry" from the issue's test list: the window
    // is a minimum wait for force_close, not a hard deadline on correcting
    // the record — as long as the channel has not yet finalized, a later
    // signed state can still supersede.
    let fx = setup(600, 400);
    let (stale, _, _) = make_state(&fx, 1, 600, 400, 1, 2);
    fx.client
        .close_unilateral(&fx.party_a, &fx.channel_id, &stale);

    advance_to(&fx.env, DISPUTE_WINDOW_SECS + 1_000);
    let (later, _, _) = make_state(&fx, 2, 500, 500, 3, 4);
    fx.client.dispute(&fx.party_b, &fx.channel_id, &later);

    assert_eq!(
        fx.client.get_pending_close(&fx.channel_id).unwrap().version,
        2
    );
}

#[test]
fn a_lower_or_equal_version_cannot_supersede() {
    let fx = setup(600, 400);
    let (current, _, _) = make_state(&fx, 10, 600, 400, 1, 2);
    fx.client
        .close_unilateral(&fx.party_a, &fx.channel_id, &current);

    let (same_version, _, _) = make_state(&fx, 10, 300, 700, 3, 4);
    let result = fx
        .client
        .try_dispute(&fx.party_b, &fx.channel_id, &same_version);
    assert_eq!(
        result.unwrap_err().unwrap(),
        ChannelsError::VersionNotHigher
    );
}

// ── Simultaneous close race ─────────────────────────────────────────────────

#[test]
fn a_second_unilateral_close_cannot_reopen_the_race_only_dispute_can() {
    // Both parties "closing at once" resolves deterministically: whoever's
    // close_unilateral lands first opens the window; the other party's only
    // recourse from then on is `dispute`, and the higher version always
    // wins regardless of closing order.
    let fx = setup(600, 400);
    let (a_close, _, _) = make_state(&fx, 40, 600, 400, 1, 2);
    fx.client
        .close_unilateral(&fx.party_a, &fx.channel_id, &a_close);

    let (b_close, _, _) = make_state(&fx, 87, 50, 950, 5, 6);
    let result = fx
        .client
        .try_close_unilateral(&fx.party_b, &fx.channel_id, &b_close);
    assert_eq!(result.unwrap_err().unwrap(), ChannelsError::ChannelNotOpen);

    // B's higher version still wins, via dispute instead.
    fx.client.dispute(&fx.party_b, &fx.channel_id, &b_close);
    assert_eq!(
        fx.client.get_pending_close(&fx.channel_id).unwrap().version,
        87
    );
}

// ── Punishment ───────────────────────────────────────────────────────────────

#[test]
fn punishment_of_a_revoked_close_pays_the_challenger_everything() {
    let fx = setup(600, 400);
    // Version 1 is signed, and both parties' revocation secrets for it are
    // generated — then the channel moves on to version 2. Revealing either
    // secret now proves version 1 was revoked.
    let (v1, secret_a_v1, _secret_b_v1) = make_state(&fx, 1, 600, 400, 111, 112);
    let (_v2, _, _) = make_state(&fx, 2, 500, 500, 113, 114);

    // Party A dishonestly closes with the revoked version 1.
    fx.client.close_unilateral(&fx.party_a, &fx.channel_id, &v1);

    let secret = BytesN::from_array(&fx.env, &secret_a_v1);
    let payout = fx.client.punish(&fx.party_b, &fx.channel_id, &secret);

    assert_eq!(
        payout, 1000,
        "the entire deposit, not just party B's honest share"
    );
    assert_eq!(
        token_balance(&fx.env, &fx.token, &fx.party_b),
        1_000_000_000 - 400 + 1000
    );
    assert_eq!(
        fx.client.get_channel(&fx.channel_id).unwrap().status,
        ChannelStatus::Closed
    );
}

#[test]
fn either_partys_revealed_secret_is_sufficient_to_punish() {
    let fx = setup(600, 400);
    let (v1, _secret_a, secret_b) = make_state(&fx, 1, 600, 400, 121, 122);
    fx.client.close_unilateral(&fx.party_a, &fx.channel_id, &v1);

    let secret = BytesN::from_array(&fx.env, &secret_b);
    let payout = fx.client.punish(&fx.party_b, &fx.channel_id, &secret);
    assert_eq!(payout, 1000);
}

#[test]
fn punishment_against_a_non_revoked_state_fails() {
    let fx = setup(600, 400);
    let (v1, _, _) = make_state(&fx, 1, 600, 400, 1, 2);
    fx.client.close_unilateral(&fx.party_a, &fx.channel_id, &v1);

    // A secret that was never committed to by this (or any) version.
    let unrelated_secret = BytesN::from_array(&fx.env, &secret_of(0xFF));
    let result = fx
        .client
        .try_punish(&fx.party_b, &fx.channel_id, &unrelated_secret);
    assert_eq!(
        result.unwrap_err().unwrap(),
        ChannelsError::InvalidRevocationSecret
    );
}

#[test]
fn the_closer_cannot_punish_themselves() {
    let fx = setup(600, 400);
    let (v1, secret_a, _) = make_state(&fx, 1, 600, 400, 1, 2);
    fx.client.close_unilateral(&fx.party_a, &fx.channel_id, &v1);

    let secret = BytesN::from_array(&fx.env, &secret_a);
    let result = fx.client.try_punish(&fx.party_a, &fx.channel_id, &secret);
    assert_eq!(
        result.unwrap_err().unwrap(),
        ChannelsError::NotTheHonestParty
    );
}

#[test]
fn punishment_is_unavailable_once_the_channel_is_open_or_already_closed() {
    let fx = setup(600, 400);
    let secret = BytesN::from_array(&fx.env, &secret_of(1));

    let while_open = fx.client.try_punish(&fx.party_b, &fx.channel_id, &secret);
    assert_eq!(
        while_open.unwrap_err().unwrap(),
        ChannelsError::ChannelNotClosing
    );

    let (v1, secret_a, _) = make_state(&fx, 1, 600, 400, 1, 2);
    fx.client.close_unilateral(&fx.party_a, &fx.channel_id, &v1);
    fx.client.punish(
        &fx.party_b,
        &fx.channel_id,
        &BytesN::from_array(&fx.env, &secret_a),
    );

    let while_closed = fx.client.try_punish(&fx.party_b, &fx.channel_id, &secret);
    assert!(while_closed.is_err());
}

// ── Deposit accounting across every path ────────────────────────────────────

#[test]
fn deposit_accounting_holds_across_cooperative_unilateral_and_punished_paths() {
    for path in ["cooperative", "uncontested_unilateral", "punished"] {
        let fx = setup(700, 300);
        let contract_id = fx.client.address.clone();
        let start_a = token_balance(&fx.env, &fx.token, &fx.party_a);
        let start_b = token_balance(&fx.env, &fx.token, &fx.party_b);

        match path {
            "cooperative" => {
                let (state, _, _) = make_state(&fx, 1, 250, 750, 1, 2);
                fx.client.close_cooperative(&fx.channel_id, &state);
                assert_eq!(
                    token_balance(&fx.env, &fx.token, &fx.party_a),
                    start_a + 250
                );
                assert_eq!(
                    token_balance(&fx.env, &fx.token, &fx.party_b),
                    start_b + 750
                );
            }
            "uncontested_unilateral" => {
                let (state, _, _) = make_state(&fx, 1, 250, 750, 1, 2);
                fx.client
                    .close_unilateral(&fx.party_a, &fx.channel_id, &state);
                advance_to(&fx.env, DISPUTE_WINDOW_SECS + 1);
                fx.client.force_close(&fx.channel_id);
                assert_eq!(
                    token_balance(&fx.env, &fx.token, &fx.party_a),
                    start_a + 250
                );
                assert_eq!(
                    token_balance(&fx.env, &fx.token, &fx.party_b),
                    start_b + 750
                );
            }
            "punished" => {
                let (v1, secret_a, _) = make_state(&fx, 1, 700, 300, 1, 2);
                fx.client.close_unilateral(&fx.party_a, &fx.channel_id, &v1);
                fx.client.punish(
                    &fx.party_b,
                    &fx.channel_id,
                    &BytesN::from_array(&fx.env, &secret_a),
                );
                assert_eq!(
                    token_balance(&fx.env, &fx.token, &fx.party_b),
                    start_b + 1000
                );
            }
            _ => unreachable!(),
        }

        // Never a stroop created or destroyed: the contract holds nothing
        // once a channel is closed.
        assert_eq!(token_balance(&fx.env, &fx.token, &contract_id), 0);
    }
}

// ── Cross-language wire compatibility ────────────────────────────────────────

/// Pinned vectors shared with `backend/src/__tests__/channels/channelState.test.js`.
///
/// Produced by `backend/src/channels/canonical.js` for
/// `{ channel_id: 42, version: 7, balance_a: 600, balance_b: 400,
///    revocation_commit_a: sha256([0x01]), revocation_commit_b: sha256([0x02]) }`.
/// A one-byte disagreement here means the contract and the Node encoder
/// silently stop agreeing on what a channel state's signature covers.
const VECTOR_COMMIT_A: [u8; 32] = [
    0x4b, 0xf5, 0x12, 0x2f, 0x34, 0x45, 0x54, 0xc5, 0x3b, 0xde, 0x2e, 0xbb, 0x8c, 0xd2, 0xb7, 0xe3,
    0xd1, 0x60, 0x0a, 0xd6, 0x31, 0xc3, 0x85, 0xa5, 0xd7, 0xcc, 0xe2, 0x3c, 0x77, 0x85, 0x45, 0x9a,
];
const VECTOR_COMMIT_B: [u8; 32] = [
    0xdb, 0xc1, 0xb4, 0xc9, 0x00, 0xff, 0xe4, 0x8d, 0x57, 0x5b, 0x5d, 0xa5, 0xc6, 0x38, 0x04, 0x01,
    0x25, 0xf6, 0x5d, 0xb0, 0xfe, 0x3e, 0x24, 0x49, 0x4b, 0x76, 0xea, 0x98, 0x64, 0x57, 0xd9, 0x86,
];
const VECTOR_COMMITMENT_HASH: [u8; 32] = [
    0x72, 0x93, 0xec, 0x05, 0x33, 0xb1, 0x37, 0xa1, 0x52, 0x9c, 0xdf, 0x4f, 0x5c, 0x01, 0x60, 0xad,
    0x27, 0xea, 0x5d, 0xb8, 0x7e, 0x2e, 0xd4, 0x65, 0xf6, 0xa6, 0x89, 0x9c, 0x0d, 0xf8, 0xb6, 0x18,
];

#[test]
fn state_hashing_matches_the_javascript_encoder() {
    let env = Env::default();
    let state = ChannelState {
        channel_id: 42,
        version: 7,
        balance_a: 600,
        balance_b: 400,
        revocation_commit_a: BytesN::from_array(&env, &VECTOR_COMMIT_A),
        revocation_commit_b: BytesN::from_array(&env, &VECTOR_COMMIT_B),
        sig_a: BytesN::from_array(&env, &[0u8; 64]),
        sig_b: BytesN::from_array(&env, &[0u8; 64]),
    };

    // The 96-byte preimage plus its one-byte domain tag.
    assert_eq!(signing_message(&env, &state).len(), 97);
    assert_eq!(
        crate::state::commitment_hash(&env, &state).to_array(),
        VECTOR_COMMITMENT_HASH
    );
}
