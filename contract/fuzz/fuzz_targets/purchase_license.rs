#![no_main]

use libfuzzer_sys::fuzz_target;
use marketplace::{AssetType, LicenseType, MarketplaceContract, MarketplaceContractClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger, LedgerInfo},
    token, Address, Env, String,
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

fn selected_price(selector: u8, data: &[u8]) -> i128 {
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

fn selected_asset_id(selector: u8, listed_id: u64, data: &[u8]) -> u64 {
    let mut raw = [0u8; 8];
    let copied = data.len().min(raw.len());
    raw[..copied].copy_from_slice(&data[..copied]);

    match selector % 5 {
        0 => listed_id,
        1 => 0,
        2 => listed_id.saturating_add(1),
        3 => u64::from_le_bytes(raw),
        _ => u64::MAX,
    }
}

fn selected_asset_version(selector: u8, current_version: u32, data: &[u8]) -> u32 {
    let mut raw = [0u8; 4];
    let copied = data.len().min(raw.len());
    raw[..copied].copy_from_slice(&data[..copied]);

    match selector % 5 {
        0 => current_version,
        1 => 0,
        2 => current_version.saturating_add(1),
        3 => 1,
        _ => u32::from_le_bytes(raw),
    }
}

fn selected_balance(selector: u8, price: i128, data: &[u8]) -> i128 {
    let required = if price > 0 { price } else { 0 };
    let ordinary = (arbitrary_i128(data).unsigned_abs() % 10_000_000_001) as i128;

    match selector % 5 {
        0 => 0,
        1 => required.saturating_sub(1),
        2 => required,
        3 => required.saturating_add(1),
        _ => ordinary,
    }
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

fuzz_target!(|data: &[u8]| {
    let env = Env::default();
    env.mock_all_auths();

    let token_administrator = Address::generate(&env);
    let asset_owner = Address::generate(&env);
    let generated_buyer = Address::generate(&env);
    let buyer = if byte_at(data, 0) % 2 == 0 {
        generated_buyer
    } else {
        asset_owner.clone()
    };

    let marketplace_id = env.register(MarketplaceContract, ());
    let marketplace = MarketplaceContractClient::new(&env, &marketplace_id);
    let token_contract = env.register_stellar_asset_contract_v2(token_administrator);
    let token_address = token_contract.address();
    let token_admin = token::StellarAssetClient::new(&env, &token_address);
    let token_client = token::Client::new(&env, &token_address);

    let payload = data.get(8..).unwrap_or_default();
    let price = selected_price(byte_at(data, 1), payload);
    let asset_type = asset_type(byte_at(data, 2));
    let license_type = license_type(byte_at(data, 3));
    let name = String::from_str(&env, "Fuzz Asset");
    let description = String::from_str(&env, "Printable ASCII marketplace asset");

    let listed_id = match marketplace.try_list_asset(
        &asset_owner,
        &name,
        &description,
        &asset_type,
        &license_type,
        &price,
    ) {
        Ok(Ok(asset_id)) => asset_id,
        _ => return,
    };

    let purchase_asset_id = selected_asset_id(byte_at(data, 4), listed_id, payload);
    let requested_balance = selected_balance(byte_at(data, 5), price, payload);
    if requested_balance > 0 {
        let _ = token_admin.try_mint(&buyer, &requested_balance);
    }

    let purchase_timestamp = selected_timestamp(byte_at(data, 6), payload);
    env.ledger().set(LedgerInfo {
        timestamp: purchase_timestamp,
        protocol_version: 22,
        sequence_number: 10,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: 16,
        min_persistent_entry_ttl: 100_000,
        max_entry_ttl: 6_312_000,
    });

    let buyer_balance_before = token_client.balance(&buyer);
    let owner_balance_before = token_client.balance(&asset_owner);
    let usage_count_before = marketplace
        .get_asset(&listed_id)
        .expect("the listed asset must remain retrievable")
        .usage_count;
    let current_version = marketplace
        .get_asset(&listed_id)
        .expect("the listed asset must remain retrievable")
        .version;
    let use_explicit_version = byte_at(data, 7) % 2 == 1;
    let requested_version = selected_asset_version(byte_at(payload, 0), current_version, payload);

    let purchase_result = if use_explicit_version {
        marketplace.try_purchase_license_version(
            &buyer,
            &purchase_asset_id,
            &requested_version,
            &token_address,
        )
    } else {
        marketplace.try_purchase_license(&buyer, &purchase_asset_id, &token_address)
    };

    match purchase_result {
        Ok(Ok(license)) => {
            assert_eq!(purchase_asset_id, listed_id);
            assert_ne!(buyer, asset_owner);
            assert!(price >= 0);

            let expected_calls_remaining = match license_type {
                LicenseType::UsageBased => 100,
                _ => u64::MAX,
            };
            assert_eq!(license.buyer, buyer);
            assert_eq!(license.asset_id, purchase_asset_id);
            assert_eq!(
                license.asset_version,
                if use_explicit_version {
                    requested_version
                } else {
                    current_version
                }
            );
            assert_eq!(license.license_type, license_type);
            assert_eq!(license.purchased_at, purchase_timestamp);
            assert_eq!(license.calls_remaining, expected_calls_remaining);

            let expected_usage_count = usage_count_before
                .checked_add(1)
                .expect("usage count must have room to increase");
            let stored_asset = marketplace
                .get_asset(&purchase_asset_id)
                .expect("a purchased asset must remain retrievable");
            assert_eq!(stored_asset.usage_count, expected_usage_count);

            let stored_license = marketplace
                .get_license(&buyer, &purchase_asset_id)
                .expect("a successful purchase must store its license");
            assert_eq!(stored_license.buyer, buyer);
            assert_eq!(stored_license.asset_id, purchase_asset_id);
            assert_eq!(stored_license.asset_version, license.asset_version);
            assert_eq!(stored_license.license_type, license_type);
            assert_eq!(stored_license.purchased_at, purchase_timestamp);
            assert_eq!(stored_license.calls_remaining, expected_calls_remaining);

            if price > 0 {
                let expected_buyer_balance = buyer_balance_before
                    .checked_sub(price)
                    .expect("a successful positive-price purchase must not underflow");
                let expected_owner_balance = owner_balance_before
                    .checked_add(price)
                    .expect("a successful positive-price purchase must not overflow");
                assert_eq!(token_client.balance(&buyer), expected_buyer_balance);
                assert_eq!(token_client.balance(&asset_owner), expected_owner_balance);
            } else {
                assert_eq!(token_client.balance(&buyer), buyer_balance_before);
                assert_eq!(token_client.balance(&asset_owner), owner_balance_before);
            }
        }
        _ => {
            let listed_asset = marketplace
                .get_asset(&listed_id)
                .expect("a rejected purchase must preserve the listed asset");
            assert_eq!(listed_asset.usage_count, usage_count_before);
            assert_eq!(token_client.balance(&buyer), buyer_balance_before);
            assert_eq!(token_client.balance(&asset_owner), owner_balance_before);

            let license_lookup = marketplace.try_get_license(&buyer, &purchase_asset_id);
            assert!(matches!(license_lookup, Ok(Ok(None))));
        }
    }
});
