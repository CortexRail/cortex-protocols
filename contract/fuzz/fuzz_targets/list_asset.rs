#![no_main]

use libfuzzer_sys::fuzz_target;
use marketplace::{AssetType, LicenseType, MarketplaceContract, MarketplaceContractClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger, LedgerInfo},
    Address, Env, String,
};

const MAX_GENERATED_STRING_LEN: usize = 4_096;

fn byte_at(data: &[u8], index: usize) -> u8 {
    data.get(index).copied().unwrap_or(0)
}

fn generated_bytes(selector: u8, seed: &[u8]) -> std::vec::Vec<u8> {
    let first = byte_at(seed, 0) as usize;
    let second = byte_at(seed, 1) as usize;
    let length = match selector % 10 {
        0 => 0,
        1 => 1 + first % 16,
        2 => 64 + ((first << 8 | second) % 193),
        3 => 1_024 + ((first << 8 | second) % (MAX_GENERATED_STRING_LEN - 1_023)),
        4 => 31,
        5 => 32,
        6 => 33,
        7 => 255,
        8 => 256,
        _ => 257,
    };

    if length == 0 {
        return std::vec::Vec::new();
    }

    let mut bytes = std::vec::Vec::with_capacity(length);
    for index in 0..length {
        let input = if seed.is_empty() {
            selector
        } else {
            seed[index % seed.len()]
        };
        bytes.push(b' ' + input % 95);
    }
    bytes
}

fn asset_type(selector: u8) -> AssetType {
    match selector % 8 {
        0 => AssetType::Prompt,
        1 => AssetType::Workflow,
        2 => AssetType::ReasoningChain,
        3 => AssetType::Dataset,
        4 => AssetType::Evaluator,
        5 => AssetType::MemorySystem,
        6 => AssetType::ModelInstruction,
        _ => AssetType::Tool,
    }
}

fn license_type(selector: u8) -> LicenseType {
    match selector % 4 {
        0 => LicenseType::Perpetual,
        1 => LicenseType::UsageBased,
        2 => LicenseType::Subscription,
        _ => LicenseType::OpenSource,
    }
}

fn selected_price(selector: u8, data: &[u8]) -> i128 {
    let mut raw = [0u8; 16];
    let copied = data.len().min(raw.len());
    raw[..copied].copy_from_slice(&data[..copied]);
    let arbitrary = i128::from_le_bytes(raw);

    match selector % 8 {
        0 => i128::MIN,
        1 => -2 - (arbitrary.unsigned_abs() % 1_000_000_000_000) as i128,
        2 => -1,
        3 => 0,
        4 => 1,
        5 => 2 + (arbitrary.unsigned_abs() % 1_000_000_000_000) as i128,
        6 => i128::MAX,
        _ => arbitrary,
    }
}

fn selected_timestamp(selector: u8, data: &[u8]) -> u64 {
    let mut raw = [0u8; 8];
    let copied = data.len().min(raw.len());
    raw[..copied].copy_from_slice(&data[..copied]);

    match selector % 5 {
        0 => 0,
        1 => 1,
        2 => u64::from_le_bytes(raw),
        3 => u64::MAX - 1,
        _ => u64::MAX,
    }
}

fuzz_target!(|data: &[u8]| {
    let env = Env::default();
    env.mock_all_auths();

    let payload = data.get(6..).unwrap_or_default();
    let timestamp = selected_timestamp(byte_at(data, 5), payload);
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

    let owner = Address::generate(&env);
    let contract_id = env.register(MarketplaceContract, ());
    let client = MarketplaceContractClient::new(&env, &contract_id);

    let split = payload.len() / 2;
    let name_bytes = generated_bytes(byte_at(data, 0), &payload[..split]);
    let description_bytes = generated_bytes(byte_at(data, 1), &payload[split..]);
    let name = String::from_bytes(&env, &name_bytes);
    let description = String::from_bytes(&env, &description_bytes);
    let asset_type = asset_type(byte_at(data, 2));
    let license = license_type(byte_at(data, 3));
    let price = selected_price(byte_at(data, 4), payload);

    if let Ok(Ok(asset_id)) =
        client.try_list_asset(&owner, &name, &description, &asset_type, &license, &price)
    {
        assert!(asset_id > 0);
        let stored = client
            .get_asset(&asset_id)
            .expect("a successfully listed asset must be retrievable");
        assert_eq!(stored.id, asset_id);
        assert_eq!(stored.owner, owner);
        assert_eq!(stored.price, price);
        assert_eq!(stored.created_at, timestamp);
        assert_eq!(stored.version, 1);

        let history = client.get_asset_history(&asset_id);
        assert_eq!(history.len(), 1);
        let initial = history.get(0).expect("version one must be retained");
        assert_eq!(initial.version, 1);
        assert_eq!(initial.description, description);
        assert_eq!(initial.updated_at, timestamp);
    }
});
