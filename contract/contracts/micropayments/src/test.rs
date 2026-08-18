#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger, LedgerInfo},
    token, Address, Env,
};

fn setup() -> (Env, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(MicropaymentsContract, ());
    (env, contract_id)
}

fn create_token_and_mint(env: &Env, user: &Address, amount: i128) -> Address {
    let token_admin = Address::generate(env);
    let contract_address = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_sac = token::StellarAssetClient::new(env, &contract_address.address());
    token_sac.mint(user, &amount);
    contract_address.address()
}

#[test]
fn test_open_stream() {
    let (env, contract_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = create_token_and_mint(&env, &sender, 100_000_000);

    let client = MicropaymentsContractClient::new(&env, &contract_id);
    let stream_id = client.open_stream(&sender, &recipient, &token, &10_000_000, &100, &3600);

    assert_eq!(stream_id, 1);
    assert_eq!(client.stream_count(), 1);

    let stream = client.get_stream(&1).unwrap();
    assert_eq!(stream.deposit, 10_000_000);
    assert_eq!(stream.status, StreamStatus::Active);
}

#[test]
fn test_withdraw_accrued() {
    let (env, contract_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = create_token_and_mint(&env, &sender, 100_000_000);

    let client = MicropaymentsContractClient::new(&env, &contract_id);
    client.open_stream(&sender, &recipient, &token, &10_000_000, &1_000, &3600);

    env.ledger().set(LedgerInfo {
        timestamp: 100,
        protocol_version: 22,
        sequence_number: 10,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: 16,
        min_persistent_entry_ttl: 100_000,
        max_entry_ttl: 6_312_000,
    });

    let withdrawn = client.withdraw(&recipient, &1);
    assert_eq!(withdrawn, 100_000);
}

#[test]
fn test_cancel_stream_refunds_sender() {
    let (env, contract_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = create_token_and_mint(&env, &sender, 100_000_000);

    let client = MicropaymentsContractClient::new(&env, &contract_id);
    client.open_stream(&sender, &recipient, &token, &10_000_000, &100, &3600);

    client.cancel_stream(&sender, &1);

    let stream = client.get_stream(&1).unwrap();
    assert_eq!(stream.status, StreamStatus::Cancelled);
}

#[test]
fn test_pause_and_resume() {
    let (env, contract_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = create_token_and_mint(&env, &sender, 100_000_000);

    let client = MicropaymentsContractClient::new(&env, &contract_id);
    client.open_stream(&sender, &recipient, &token, &10_000_000, &100, &7200);

    client.pause_stream(&sender, &1);
    let stream = client.get_stream(&1).unwrap();
    assert_eq!(stream.status, StreamStatus::Paused);

    client.resume_stream(&sender, &1);
    let stream = client.get_stream(&1).unwrap();
    assert_eq!(stream.status, StreamStatus::Active);
}

#[test]
fn test_withdraw_before_time_elapsed() {
    let (env, contract_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = create_token_and_mint(&env, &sender, 100_000_000);

    let client = MicropaymentsContractClient::new(&env, &contract_id);

    client.open_stream(&sender, &recipient, &token, &10_000_000, &1_000, &3600);

    let withdrawn = client.withdraw(&recipient, &1);

    assert_eq!(withdrawn, 0);
}

#[test]
fn test_multiple_withdrawals() {
    let (env, contract_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = create_token_and_mint(&env, &sender, 100_000_000);

    let client = MicropaymentsContractClient::new(&env, &contract_id);

    client.open_stream(&sender, &recipient, &token, &10_000_000, &1_000, &3600);

    env.ledger().set(LedgerInfo {
        timestamp: 100,
        protocol_version: 22,
        sequence_number: 10,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: 16,
        min_persistent_entry_ttl: 100_000,
        max_entry_ttl: 6_312_000,
    });

    let first = client.withdraw(&recipient, &1);
    assert_eq!(first, 100_000);

    env.ledger().set(LedgerInfo {
        timestamp: 200,
        protocol_version: 22,
        sequence_number: 11,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: 16,
        min_persistent_entry_ttl: 100_000,
        max_entry_ttl: 6_312_000,
    });

    let second = client.withdraw(&recipient, &1);
    assert_eq!(second, 100_000);
}

#[test]
fn test_withdraw_capped_by_deposit() {
    let (env, contract_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = create_token_and_mint(&env, &sender, 100_000_000);

    let client = MicropaymentsContractClient::new(&env, &contract_id);

    client.open_stream(&sender, &recipient, &token, &10_000_000, &10_000, &1000);

    env.ledger().set(LedgerInfo {
        timestamp: 5000,
        protocol_version: 22,
        sequence_number: 20,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: 16,
        min_persistent_entry_ttl: 100_000,
        max_entry_ttl: 6_312_000,
    });

    let withdrawn = client.withdraw(&recipient, &1);

    assert_eq!(withdrawn, 10_000_000);
}

#[test]
fn test_cancel_after_partial_withdrawal() {
    let (env, contract_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = create_token_and_mint(&env, &sender, 100_000_000);

    let client = MicropaymentsContractClient::new(&env, &contract_id);

    client.open_stream(&sender, &recipient, &token, &10_000_000, &1_000, &3600);

    env.ledger().set(LedgerInfo {
        timestamp: 100,
        protocol_version: 22,
        sequence_number: 10,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: 16,
        min_persistent_entry_ttl: 100_000,
        max_entry_ttl: 6_312_000,
    });

    let withdrawn = client.withdraw(&recipient, &1);
    assert_eq!(withdrawn, 100_000);

    client.cancel_stream(&sender, &1);

    let stream = client.get_stream(&1).unwrap();
    assert_eq!(stream.status, StreamStatus::Cancelled);
}

#[test]
fn test_batch_settle_and_claimable_batch() {
    let (env, contract_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = create_token_and_mint(&env, &sender, 100_000_000);

    let client = MicropaymentsContractClient::new(&env, &contract_id);

    let id1 = client.open_stream(&sender, &recipient, &token, &10_000_000, &1_000, &3600);
    let id2 = client.open_stream(&sender, &recipient, &token, &20_000_000, &2_000, &3600);

    env.ledger().set(LedgerInfo {
        timestamp: 100,
        protocol_version: 22,
        sequence_number: 10,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: 16,
        min_persistent_entry_ttl: 100_000,
        max_entry_ttl: 6_312_000,
    });

    let mut query_ids = soroban_sdk::Vec::new(&env);
    query_ids.push_back(id1);
    query_ids.push_back(id2);

    let claimables = client.get_claimable_batch(&query_ids);
    assert_eq!(claimables.get(id1).unwrap(), 100_000);
    assert_eq!(claimables.get(id2).unwrap(), 200_000);

    let settled = client.batch_settle(&recipient, &query_ids, &1);
    assert_eq!(settled.get(id1).unwrap(), 100_000);
    assert_eq!(settled.get(id2).unwrap(), 200_000);

    let stream1 = client.get_stream(&id1).unwrap();
    assert_eq!(stream1.withdrawn, 100_000);
    assert_eq!(stream1.last_settled, 100);
}

#[test]
fn test_batch_settle_with_nonce() {
    let (env, contract_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = create_token_and_mint(&env, &sender, 100_000_000);

    let client = MicropaymentsContractClient::new(&env, &contract_id);

    let id1 = client.open_stream(&sender, &recipient, &token, &10_000_000, &1_000, &3600);
    let id2 = client.open_stream(&sender, &recipient, &token, &20_000_000, &2_000, &3600);

    env.ledger().set(LedgerInfo {
        timestamp: 100,
        protocol_version: 22,
        sequence_number: 10,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: 16,
        min_persistent_entry_ttl: 100_000,
        max_entry_ttl: 6_312_000,
    });

    let mut query_ids = soroban_sdk::Vec::new(&env);
    query_ids.push_back(id1);
    query_ids.push_back(id2);

    let settled = client.batch_settle(&recipient, &query_ids, &42);
    assert_eq!(settled.get(id1).unwrap(), 100_000);
    assert_eq!(settled.get(id2).unwrap(), 200_000);
}

#[test]
fn test_nonce_replay_returns_cached_result() {
    let (env, contract_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = create_token_and_mint(&env, &sender, 100_000_000);

    let client = MicropaymentsContractClient::new(&env, &contract_id);

    let id1 = client.open_stream(&sender, &recipient, &token, &10_000_000, &1_000, &3600);

    env.ledger().set(LedgerInfo {
        timestamp: 100,
        protocol_version: 22,
        sequence_number: 10,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: 16,
        min_persistent_entry_ttl: 100_000,
        max_entry_ttl: 6_312_000,
    });

    let mut query_ids = soroban_sdk::Vec::new(&env);
    query_ids.push_back(id1);

    // First settlement with nonce 42
    let settled1 = client.batch_settle(&recipient, &query_ids, &42);
    assert_eq!(settled1.get(id1).unwrap(), 100_000);

    let stream1 = client.get_stream(&id1).unwrap();
    assert_eq!(stream1.withdrawn, 100_000);

    // Replay with same nonce - should return cached result without double-payment
    let settled2 = client.batch_settle(&recipient, &query_ids, &42);
    assert_eq!(settled2.get(id1).unwrap(), 100_000);

    // Withdrawn amount should not have increased
    let stream1_after = client.get_stream(&id1).unwrap();
    assert_eq!(stream1_after.withdrawn, 100_000);
}

#[test]
fn test_different_nonces_execute_separately() {
    let (env, contract_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = create_token_and_mint(&env, &sender, 100_000_000);

    let client = MicropaymentsContractClient::new(&env, &contract_id);

    let id1 = client.open_stream(&sender, &recipient, &token, &10_000_000, &1_000, &3600);

    env.ledger().set(LedgerInfo {
        timestamp: 100,
        protocol_version: 22,
        sequence_number: 10,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: 16,
        min_persistent_entry_ttl: 100_000,
        max_entry_ttl: 6_312_000,
    });

    let mut query_ids = soroban_sdk::Vec::new(&env);
    query_ids.push_back(id1);

    // First settlement with nonce 42
    let settled1 = client.batch_settle(&recipient, &query_ids, &42);
    assert_eq!(settled1.get(id1).unwrap(), 100_000);

    // Advance time
    env.ledger().set(LedgerInfo {
        timestamp: 200,
        protocol_version: 22,
        sequence_number: 11,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: 16,
        min_persistent_entry_ttl: 100_000,
        max_entry_ttl: 6_312_000,
    });

    // Second settlement with different nonce 43 - should execute new transfer
    let settled2 = client.batch_settle(&recipient, &query_ids, &43);
    assert_eq!(settled2.get(id1).unwrap(), 100_000);

    let stream1 = client.get_stream(&id1).unwrap();
    assert_eq!(stream1.withdrawn, 200_000);
}

#[test]
fn test_nonce_isolation_per_recipient() {
    let (env, contract_id) = setup();
    let sender = Address::generate(&env);
    let recipient1 = Address::generate(&env);
    let recipient2 = Address::generate(&env);
    let token = create_token_and_mint(&env, &sender, 100_000_000);

    let client = MicropaymentsContractClient::new(&env, &contract_id);

    let id1 = client.open_stream(&sender, &recipient1, &token, &10_000_000, &1_000, &3600);
    let id2 = client.open_stream(&sender, &recipient2, &token, &20_000_000, &2_000, &3600);

    env.ledger().set(LedgerInfo {
        timestamp: 100,
        protocol_version: 22,
        sequence_number: 10,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: 16,
        min_persistent_entry_ttl: 100_000,
        max_entry_ttl: 6_312_000,
    });

    let mut query_ids1 = soroban_sdk::Vec::new(&env);
    query_ids1.push_back(id1);

    let mut query_ids2 = soroban_sdk::Vec::new(&env);
    query_ids2.push_back(id2);

    // Both recipients can use the same nonce without conflict
    let settled1 = client.batch_settle(&recipient1, &query_ids1, &99);
    assert_eq!(settled1.get(id1).unwrap(), 100_000);

    let settled2 = client.batch_settle(&recipient2, &query_ids2, &99);
    assert_eq!(settled2.get(id2).unwrap(), 200_000);
}

#[test]
fn test_get_settlement_status() {
    let (env, contract_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = create_token_and_mint(&env, &sender, 100_000_000);

    let client = MicropaymentsContractClient::new(&env, &contract_id);

    let id1 = client.open_stream(&sender, &recipient, &token, &10_000_000, &1_000, &3600);
    let id2 = client.open_stream(&sender, &recipient, &token, &20_000_000, &2_000, &3600);

    env.ledger().set(LedgerInfo {
        timestamp: 100,
        protocol_version: 22,
        sequence_number: 10,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: 16,
        min_persistent_entry_ttl: 100_000,
        max_entry_ttl: 6_312_000,
    });

    let mut query_ids = soroban_sdk::Vec::new(&env);
    query_ids.push_back(id1);
    query_ids.push_back(id2);

    let status = client.get_settlement_status(&query_ids);
    
    let status1 = status.get(id1).unwrap();
    assert_eq!(status1.last_settled_amount, 0);
    assert_eq!(status1.ledger_sequence, 10);

    let status2 = status.get(id2).unwrap();
    assert_eq!(status2.last_settled_amount, 0);
    assert_eq!(status2.ledger_sequence, 10);
}

#[test]
fn test_get_settlement_status_after_withdrawal() {
    let (env, contract_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = create_token_and_mint(&env, &sender, 100_000_000);

    let client = MicropaymentsContractClient::new(&env, &contract_id);

    let id1 = client.open_stream(&sender, &recipient, &token, &10_000_000, &1_000, &3600);

    env.ledger().set(LedgerInfo {
        timestamp: 100,
        protocol_version: 22,
        sequence_number: 10,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: 16,
        min_persistent_entry_ttl: 100_000,
        max_entry_ttl: 6_312_000,
    });

    client.withdraw(&recipient, &id1);

    let mut query_ids = soroban_sdk::Vec::new(&env);
    query_ids.push_back(id1);

    let status = client.get_settlement_status(&query_ids);
    let status1 = status.get(id1).unwrap();
    assert_eq!(status1.last_settled_amount, 100_000);
    assert_eq!(status1.ledger_sequence, 10);
}

#[test]
fn test_get_settlement_status_non_existent_stream() {
    let (env, contract_id) = setup();
    let client = MicropaymentsContractClient::new(&env, &contract_id);

    env.ledger().set(LedgerInfo {
        timestamp: 100,
        protocol_version: 22,
        sequence_number: 10,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: 16,
        min_persistent_entry_ttl: 100_000,
        max_entry_ttl: 6_312_000,
    });

    let mut query_ids = soroban_sdk::Vec::new(&env);
    query_ids.push_back(999);

    let status = client.get_settlement_status(&query_ids);
    let status999 = status.get(999).unwrap();
    assert_eq!(status999.last_settled_amount, 0);
    assert_eq!(status999.ledger_sequence, 10);
}

#[test]
fn test_batch_settle_with_zero_claimable() {
    let (env, contract_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = create_token_and_mint(&env, &sender, 100_000_000);

    let client = MicropaymentsContractClient::new(&env, &contract_id);

    let id1 = client.open_stream(&sender, &recipient, &token, &10_000_000, &1_000, &3600);

    // No time elapsed - claimable should be 0
    let mut query_ids = soroban_sdk::Vec::new(&env);
    query_ids.push_back(id1);

    let settled = client.batch_settle(&recipient, &query_ids, &1);
    assert_eq!(settled.get(id1).unwrap(), 0);

    let stream1 = client.get_stream(&id1).unwrap();
    assert_eq!(stream1.withdrawn, 0);
}

#[test]
fn test_batch_settle_mixed_claimable() {
    let (env, contract_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = create_token_and_mint(&env, &sender, 100_000_000);

    let client = MicropaymentsContractClient::new(&env, &contract_id);

    let id1 = client.open_stream(&sender, &recipient, &token, &10_000_000, &1_000, &3600);
    let id2 = client.open_stream(&sender, &recipient, &token, &20_000_000, &2_000, &3600);

    env.ledger().set(LedgerInfo {
        timestamp: 100,
        protocol_version: 22,
        sequence_number: 10,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: 16,
        min_persistent_entry_ttl: 100_000,
        max_entry_ttl: 6_312_000,
    });

    // Settle id1 first
    let mut query_ids1 = soroban_sdk::Vec::new(&env);
    query_ids1.push_back(id1);
    client.batch_settle(&recipient, &query_ids1, &1);

    // Now batch settle both - id1 should have 0 claimable, id2 should have 200_000
    let mut query_ids2 = soroban_sdk::Vec::new(&env);
    query_ids2.push_back(id1);
    query_ids2.push_back(id2);

    let settled = client.batch_settle(&recipient, &query_ids2, &2);
    assert_eq!(settled.get(id1).unwrap(), 0);
    assert_eq!(settled.get(id2).unwrap(), 200_000);
}

#[test]
fn test_batch_settle_auto_completes_exhausted_stream() {
    let (env, contract_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = create_token_and_mint(&env, &sender, 100_000_000);

    let client = MicropaymentsContractClient::new(&env, &contract_id);

    let id1 = client.open_stream(&sender, &recipient, &token, &10_000_000, &10_000, &1000);

    env.ledger().set(LedgerInfo {
        timestamp: 5000,
        protocol_version: 22,
        sequence_number: 20,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: 16,
        min_persistent_entry_ttl: 100_000,
        max_entry_ttl: 6_312_000,
    });

    let mut query_ids = soroban_sdk::Vec::new(&env);
    query_ids.push_back(id1);

    let settled = client.batch_settle(&recipient, &query_ids, &1);
    assert_eq!(settled.get(id1).unwrap(), 10_000_000);

    let stream1 = client.get_stream(&id1).unwrap();
    assert_eq!(stream1.status, StreamStatus::Completed);
}

#[test]
fn test_batch_settle_auto_completes_expired_stream() {
    let (env, contract_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = create_token_and_mint(&env, &sender, 100_000_000);

    let client = MicropaymentsContractClient::new(&env, &contract_id);

    let id1 = client.open_stream(&sender, &recipient, &token, &10_000_000, &1_000, &100);

    env.ledger().set(LedgerInfo {
        timestamp: 5000,
        protocol_version: 22,
        sequence_number: 20,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: 16,
        min_persistent_entry_ttl: 100_000,
        max_entry_ttl: 6_312_000,
    });

    let mut query_ids = soroban_sdk::Vec::new(&env);
    query_ids.push_back(id1);

    let settled = client.batch_settle(&recipient, &query_ids, &1);
    
    let stream1 = client.get_stream(&id1).unwrap();
    assert_eq!(stream1.status, StreamStatus::Completed);
}

