#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token, Address, Env, String,
};

fn setup() -> (Env, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let contract_id = env.register(MarketplaceContract, ());
    (env, admin, contract_id)
}

fn create_token(env: &Env, admin: &Address) -> (Address, token::StellarAssetClient) {
    let token_admin = Address::generate(env);
    let contract_address = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_client = token::StellarAssetClient::new(env, &contract_address.address());
    token_client.mint(admin, &10_000_000_000);
    (contract_address.address(), token_client)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Build a `soroban_sdk::String` from a `&str` that is exactly `n` bytes long
/// by repeating the character `'a'` (1 byte each in UTF-8).
fn str_of_len(env: &Env, n: usize) -> String {
    // Build the string in a std buffer (we are in test context so std is fine
    // via the test harness).
    let mut s = soroban_sdk::vec![env]; // not used — just for clarity
    let _ = s; // suppress warning
    // Use the bytes constructor via a fixed-length slice approach.
    // The simplest portable way in soroban tests is to construct from a literal
    // and then rely on the fact that the SDK accepts &str slices in test mode.
    // We abuse `String::from_str` which is available in test builds.
    let raw: soroban_sdk::bytes::Bytes = {
        // Build a native Vec<u8> of `n` 'a' bytes then hand it to the SDK.
        extern crate std;
        let v: std::vec::Vec<u8> = std::vec![b'a'; n];
        soroban_sdk::bytes::Bytes::from_slice(env, &v)
    };
    String::from_bytes(env, &raw)
}

// ── Existing happy-path tests (updated to unwrap Result) ──────────────────────

#[test]
fn test_initialize() {
    let (env, admin, contract_id) = setup();
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);
    assert_eq!(client.asset_count(), 0);
}

#[test]
fn test_list_and_get_asset() {
    let (env, admin, contract_id) = setup();
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);

    let asset_id = client
        .list_asset(
            &admin,
            &String::from_str(&env, "GPT-4 Chain-of-Thought Prompt"),
            &String::from_str(&env, "Advanced reasoning prompt for complex analysis"),
            &AssetType::Prompt,
            &LicenseType::Perpetual,
            &5_000_000i128, // 0.5 XLM
        )
        .unwrap();

    assert_eq!(asset_id, 1);
    assert_eq!(client.asset_count(), 1);

    let asset = client.get_asset(&1).unwrap();
    assert_eq!(asset.id, 1);
    assert!(asset.is_active);
    assert_eq!(asset.price, 5_000_000);
}

#[test]
fn test_multiple_assets() {
    let (env, admin, contract_id) = setup();
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);

    for i in 0..5u32 {
        let name = if i == 0 {
            String::from_str(&env, "Asset One")
        } else if i == 1 {
            String::from_str(&env, "Asset Two")
        } else if i == 2 {
            String::from_str(&env, "Asset Three")
        } else if i == 3 {
            String::from_str(&env, "Asset Four")
        } else {
            String::from_str(&env, "Asset Five")
        };

        client
            .list_asset(
                &admin,
                &name,
                &String::from_str(&env, "A test intelligence asset"),
                &AssetType::Workflow,
                &LicenseType::UsageBased,
                &1_000_000i128,
            )
            .unwrap();
    }

    assert_eq!(client.asset_count(), 5);
}

#[test]
fn test_delist_asset() {
    let (env, admin, contract_id) = setup();
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);

    let asset_id = client
        .list_asset(
            &admin,
            &String::from_str(&env, "Deprecated Evaluator"),
            &String::from_str(&env, "Old evaluator being retired"),
            &AssetType::Evaluator,
            &LicenseType::Perpetual,
            &2_000_000i128,
        )
        .unwrap();

    client.delist_asset(&admin, &asset_id);

    let asset = client.get_asset(&asset_id).unwrap();
    assert!(!asset.is_active);
}

#[test]
fn test_update_price() {
    let (env, admin, contract_id) = setup();
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);

    let asset_id = client
        .list_asset(
            &admin,
            &String::from_str(&env, "Memory System v1"),
            &String::from_str(&env, "Persistent agent memory module"),
            &AssetType::MemorySystem,
            &LicenseType::Subscription,
            &10_000_000i128,
        )
        .unwrap();

    client.update_price(&admin, &asset_id, &15_000_000i128);

    let asset = client.get_asset(&asset_id).unwrap();
    assert_eq!(asset.price, 15_000_000);
}

#[test]
fn test_purchase_license() {
    let (env, admin, contract_id) = setup();
    let buyer = Address::generate(&env);
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);

    let (token_addr, token_sac) = create_token(&env, &buyer);
    token_sac.mint(&buyer, &50_000_000);

    let asset_id = client
        .list_asset(
            &admin,
            &String::from_str(&env, "Reasoning Chain Alpha"),
            &String::from_str(&env, "Multi-step reasoning for legal analysis"),
            &AssetType::ReasoningChain,
            &LicenseType::Perpetual,
            &10_000_000i128,
        )
        .unwrap();

    assert!(!client.has_license(&buyer, &asset_id));

    let license = client.purchase_license(&buyer, &asset_id, &token_addr);
    assert_eq!(license.asset_id, asset_id);
    assert!(client.has_license(&buyer, &asset_id));
}

#[test]
fn test_has_no_license_by_default() {
    let (env, admin, contract_id) = setup();
    let stranger = Address::generate(&env);
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);

    client
        .list_asset(
            &admin,
            &String::from_str(&env, "Tool Pack"),
            &String::from_str(&env, "Collection of agent tools"),
            &AssetType::Tool,
            &LicenseType::UsageBased,
            &3_000_000i128,
        )
        .unwrap();

    assert!(!client.has_license(&stranger, &1));
}

// ── Validation boundary tests ─────────────────────────────────────────────────

// Guard 1 — price > 0
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_list_asset_rejects_zero_price() {
    let (env, admin, contract_id) = setup();
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);

    let result = client.try_list_asset(
        &admin,
        &String::from_str(&env, "Free Asset"),
        &String::from_str(&env, "A valid description"),
        &AssetType::Prompt,
        &LicenseType::Perpetual,
        &0i128,
    );

    assert_eq!(
        result.unwrap_err().unwrap(),
        MarketplaceError::InvalidPrice
    );
}

#[test]
fn test_list_asset_rejects_negative_price() {
    let (env, admin, contract_id) = setup();
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);

    let result = client.try_list_asset(
        &admin,
        &String::from_str(&env, "Negative Asset"),
        &String::from_str(&env, "A valid description"),
        &AssetType::Dataset,
        &LicenseType::UsageBased,
        &-1i128,
    );

    assert_eq!(
        result.unwrap_err().unwrap(),
        MarketplaceError::InvalidPrice
    );
}

#[test]
fn test_list_asset_accepts_price_of_one_stroop() {
    // Boundary: minimum valid price is 1 stroop.
    let (env, admin, contract_id) = setup();
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);

    let result = client.try_list_asset(
        &admin,
        &String::from_str(&env, "Minimal Price Asset"),
        &String::from_str(&env, "A valid description"),
        &AssetType::Tool,
        &LicenseType::Perpetual,
        &1i128,
    );

    assert!(result.is_ok());
}

// Guard 2 — name length 1–200 bytes
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_list_asset_rejects_empty_name() {
    let (env, admin, contract_id) = setup();
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);

    let result = client.try_list_asset(
        &admin,
        &String::from_str(&env, ""),
        &String::from_str(&env, "A valid description"),
        &AssetType::Prompt,
        &LicenseType::Perpetual,
        &1_000_000i128,
    );

    assert_eq!(
        result.unwrap_err().unwrap(),
        MarketplaceError::InvalidMetadata
    );
}

#[test]
fn test_list_asset_accepts_name_of_exactly_200_bytes() {
    // Boundary: name with exactly MAX_NAME_LEN (200) bytes must succeed.
    let (env, admin, contract_id) = setup();
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);

    let name = str_of_len(&env, 200);
    let result = client.try_list_asset(
        &admin,
        &name,
        &String::from_str(&env, "A valid description"),
        &AssetType::Workflow,
        &LicenseType::OpenSource,
        &1_000_000i128,
    );

    assert!(result.is_ok());
}

#[test]
fn test_list_asset_rejects_name_of_201_bytes() {
    // Boundary: name one byte over the limit must fail.
    let (env, admin, contract_id) = setup();
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);

    let name = str_of_len(&env, 201);
    let result = client.try_list_asset(
        &admin,
        &name,
        &String::from_str(&env, "A valid description"),
        &AssetType::Evaluator,
        &LicenseType::Perpetual,
        &1_000_000i128,
    );

    assert_eq!(
        result.unwrap_err().unwrap(),
        MarketplaceError::InvalidMetadata
    );
}

// Guard 3 — description length 1–2 000 bytes
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_list_asset_rejects_empty_description() {
    let (env, admin, contract_id) = setup();
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);

    let result = client.try_list_asset(
        &admin,
        &String::from_str(&env, "Valid Name"),
        &String::from_str(&env, ""),
        &AssetType::Dataset,
        &LicenseType::Subscription,
        &1_000_000i128,
    );

    assert_eq!(
        result.unwrap_err().unwrap(),
        MarketplaceError::InvalidMetadata
    );
}

#[test]
fn test_list_asset_accepts_description_of_exactly_2000_bytes() {
    // Boundary: description with exactly MAX_DESC_LEN (2 000) bytes must succeed.
    let (env, admin, contract_id) = setup();
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);

    let desc = str_of_len(&env, 2_000);
    let result = client.try_list_asset(
        &admin,
        &String::from_str(&env, "Valid Name"),
        &desc,
        &AssetType::MemorySystem,
        &LicenseType::UsageBased,
        &1_000_000i128,
    );

    assert!(result.is_ok());
}

#[test]
fn test_list_asset_rejects_description_of_2001_bytes() {
    // Boundary: description one byte over the limit must fail.
    let (env, admin, contract_id) = setup();
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);

    let desc = str_of_len(&env, 2_001);
    let result = client.try_list_asset(
        &admin,
        &String::from_str(&env, "Valid Name"),
        &desc,
        &AssetType::ModelInstruction,
        &LicenseType::Perpetual,
        &1_000_000i128,
    );

    assert_eq!(
        result.unwrap_err().unwrap(),
        MarketplaceError::InvalidMetadata
    );
}

// Guard 4 — total asset count ≤ MAX_ASSETS (10 000)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_list_asset_rejects_when_max_assets_reached() {
    // Simulate the contract having already reached MAX_ASSETS by manually
    // writing ASSET_COUNT = MAX_ASSETS into instance storage, then attempting
    // to list one more asset.
    let (env, admin, contract_id) = setup();
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);

    // Force the asset count to MAX_ASSETS without creating real asset records.
    env.as_contract(&contract_id, || {
        env.storage()
            .instance()
            .set(&symbol_short!("A_COUNT"), &MAX_ASSETS);
    });

    let result = client.try_list_asset(
        &admin,
        &String::from_str(&env, "Overflow Asset"),
        &String::from_str(&env, "This listing should be rejected"),
        &AssetType::Tool,
        &LicenseType::Perpetual,
        &1_000_000i128,
    );

    assert_eq!(
        result.unwrap_err().unwrap(),
        MarketplaceError::AssetLimitReached
    );
}

#[test]
fn test_list_asset_accepts_when_one_below_max_assets() {
    // Boundary: MAX_ASSETS - 1 listings already present; one more must succeed.
    let (env, admin, contract_id) = setup();
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);

    env.as_contract(&contract_id, || {
        env.storage()
            .instance()
            .set(&symbol_short!("A_COUNT"), &(MAX_ASSETS - 1));
    });

    let result = client.try_list_asset(
        &admin,
        &String::from_str(&env, "Last Allowed Asset"),
        &String::from_str(&env, "This should be the 10 000th listing"),
        &AssetType::ReasoningChain,
        &LicenseType::OpenSource,
        &1_000_000i128,
    );

    assert!(result.is_ok());
    assert_eq!(client.asset_count(), MAX_ASSETS);
}
