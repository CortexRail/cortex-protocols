#![no_main]

use libfuzzer_sys::fuzz_target;
use micropayments::{MicropaymentsContract, MicropaymentsContractClient, StreamStatus};
use soroban_sdk::{
    testutils::{Address as _, Ledger, LedgerInfo},
    token, Address, Env,
};

fn byte_at(data: &[u8], index: usize) -> u8 {
    data.get(index).copied().unwrap_or(0)
}

fn arbitrary_i128(data: &[u8]) -> i128 {
    let mut raw = [0u8; 16];
    let copied = data.len().min(raw.len());
    raw[..copied].copy_from_slice(&data[..copied]);
    i128::from_le_bytes(raw)
}

fn selected_amount(selector: u8, data: &[u8]) -> i128 {
    let arbitrary = arbitrary_i128(data);

    match selector % 8 {
        0 => i128::MIN,
        1 => -2 - (arbitrary.unsigned_abs() % 1_000_000_000_000) as i128,
        2 => -1,
        3 => 0,
        4 => 1,
        5 => 2 + (arbitrary.unsigned_abs() % 1_000_000_000_000) as i128,
        6 => i128::MAX - (arbitrary.unsigned_abs() % 1_000_000) as i128,
        _ => i128::MAX,
    }
}

fn arbitrary_u64(data: &[u8]) -> u64 {
    let mut raw = [0u8; 8];
    let copied = data.len().min(raw.len());
    raw[..copied].copy_from_slice(&data[..copied]);
    u64::from_le_bytes(raw)
}

fn selected_duration(selector: u8, data: &[u8]) -> u64 {
    let arbitrary = arbitrary_u64(data);

    match selector % 5 {
        0 => 0,
        1 => 1,
        2 => arbitrary,
        3 => u64::MAX - 1 - arbitrary % 1_024,
        _ => u64::MAX,
    }
}

fn selected_timestamp(selector: u8, data: &[u8]) -> u64 {
    match selector % 5 {
        0 => 0,
        1 => 1,
        2 => arbitrary_u64(data),
        3 => u64::MAX - 1,
        _ => u64::MAX,
    }
}

fn selected_balance(selector: u8, deposit: i128, data: &[u8]) -> i128 {
    let required = if deposit > 0 { deposit } else { 0 };
    let ordinary = (arbitrary_i128(data).unsigned_abs() % 10_000_000_001) as i128;

    match selector % 5 {
        0 => 0,
        1 => required.saturating_sub(1),
        2 => required,
        3 => required.checked_add(1).unwrap_or(ordinary),
        _ => ordinary,
    }
}

fuzz_target!(|data: &[u8]| {
    let env = Env::default();
    env.mock_all_auths();

    let token_administrator = Address::generate(&env);
    let sender = Address::generate(&env);
    let generated_recipient = Address::generate(&env);
    let recipient = if byte_at(data, 0) % 2 == 0 {
        generated_recipient
    } else {
        sender.clone()
    };

    let contract_id = env.register(MicropaymentsContract, ());
    let contract = MicropaymentsContractClient::new(&env, &contract_id);
    let token_contract = env.register_stellar_asset_contract_v2(token_administrator);
    let token_address = token_contract.address();
    let token_admin = token::StellarAssetClient::new(&env, &token_address);
    let token_client = token::Client::new(&env, &token_address);

    let payload = data.get(6..).unwrap_or_default();
    let midpoint = payload.len() / 2;
    let deposit = selected_amount(byte_at(data, 1), &payload[..midpoint]);
    let rate_per_second = selected_amount(byte_at(data, 2), &payload[midpoint..]);
    let duration_secs = selected_duration(byte_at(data, 3), payload);
    let timestamp = selected_timestamp(byte_at(data, 4), payload);
    let requested_balance = selected_balance(byte_at(data, 5), deposit, payload);

    if requested_balance > 0 {
        let _ = token_admin.try_mint(&sender, &requested_balance);
    }

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

    let stream_count_before = contract.stream_count();
    let expected_stream_id = stream_count_before
        .checked_add(1)
        .expect("stream ID must have room to increase");
    let sender_balance_before = token_client.balance(&sender);
    let recipient_balance_before = token_client.balance(&recipient);
    let contract_balance_before = token_client.balance(&contract_id);

    let open_result = contract.try_open_stream(
        &sender,
        &recipient,
        &token_address,
        &deposit,
        &rate_per_second,
        &duration_secs,
    );

    match open_result {
        Ok(Ok(stream_id)) => {
            assert!(stream_id > 0);
            assert_eq!(stream_id, expected_stream_id);
            assert!(deposit > 0);
            assert!(rate_per_second > 0);
            assert!(sender_balance_before >= deposit);

            let expected_end_time = timestamp
                .checked_add(duration_secs)
                .expect("a successful stream must not overflow its end time");
            let stored = contract
                .get_stream(&stream_id)
                .expect("a successful open must store its stream");
            assert_eq!(stored.id, stream_id);
            assert_eq!(stored.sender, sender);
            assert_eq!(stored.recipient, recipient);
            assert_eq!(stored.token, token_address);
            assert_eq!(stored.deposit, deposit);
            assert_eq!(stored.rate_per_second, rate_per_second);
            assert_eq!(stored.start_time, timestamp);
            assert_eq!(stored.end_time, expected_end_time);
            assert_eq!(stored.last_settled, timestamp);
            assert_eq!(stored.withdrawn, 0);
            assert_eq!(stored.status, StreamStatus::Active);
            assert_eq!(contract.stream_count(), expected_stream_id);

            let expected_sender_balance = sender_balance_before
                .checked_sub(deposit)
                .expect("a successful deposit must not underflow sender balance");
            let expected_contract_balance = contract_balance_before
                .checked_add(deposit)
                .expect("a successful deposit must not overflow contract balance");
            assert_eq!(token_client.balance(&sender), expected_sender_balance);
            assert_eq!(
                token_client.balance(&contract_id),
                expected_contract_balance
            );
            if recipient != sender {
                assert_eq!(token_client.balance(&recipient), recipient_balance_before);
            }
        }
        _ => {
            assert_eq!(token_client.balance(&sender), sender_balance_before);
            assert_eq!(token_client.balance(&contract_id), contract_balance_before);
            assert_eq!(token_client.balance(&recipient), recipient_balance_before);
            assert_eq!(contract.stream_count(), stream_count_before);

            let stream_lookup = contract.try_get_stream(&expected_stream_id);
            assert!(matches!(stream_lookup, Ok(Ok(None))));
        }
    }
});
