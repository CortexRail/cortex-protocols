#![cfg(test)]

use super::*;
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _, Ledger, MockAuth, MockAuthInvoke},
    token, vec, Address, Bytes, BytesN, Env, FromVal, IntoVal, Map, String,
};

fn setup() -> (Env, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let contract_id = env.register(MarketplaceContract, ());
    (env, admin, contract_id)
}

fn create_token<'a>(env: &'a Env, admin: &Address) -> (Address, token::StellarAssetClient<'a>) {
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
    extern crate std;
    let v: std::vec::Vec<u8> = std::vec![b'a'; n];
    String::from_bytes(env, &v)
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
        );

    assert_eq!(asset_id, 1);
    assert_eq!(client.asset_count(), 1);

    let asset = client.get_asset(&1).unwrap();
    assert_eq!(asset.id, 1);
    assert!(asset.is_active);
    assert_eq!(asset.price, 5_000_000);
    assert_eq!(asset.version, 1);

    let history = client.get_asset_history(&asset_id);
    assert_eq!(history.len(), 1);
    assert_eq!(history.get(0).unwrap().version, 1);
    assert_eq!(history.get(0).unwrap().description, asset.description);
    assert_eq!(client.get_asset_version(&asset_id, &1), history.get(0));
}

#[test]
fn test_publish_update() {
    let (env, admin, contract_id) = setup();
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);
    let asset_id = client.list_asset(
        &admin,
        &String::from_str(&env, "Versioned Asset"),
        &String::from_str(&env, "Version one"),
        &AssetType::Prompt,
        &LicenseType::Perpetual,
        &1_000_000,
    );

    client.publish_update(&admin, &asset_id, &String::from_str(&env, "Version two"));

    // Invocation metering clears prior events at the start of the next contract
    // call, so inspect the update event before issuing state queries.
    let events = env.events().all();
    let (_, topics, data) = events.last().unwrap();
    let expected_topics = vec![
        &env,
        symbol_short!("UPDATED").into_val(&env),
        admin.into_val(&env),
    ];
    let actual_data = <(u64, u32, u32)>::from_val(&env, &data);
    assert_eq!(topics, expected_topics);
    assert_eq!(actual_data, (asset_id, 1, 2));

    let asset = client.get_asset(&asset_id).unwrap();
    assert_eq!(asset.version, 2);
    assert_eq!(asset.description, String::from_str(&env, "Version two"));
    let history = client.get_asset_history(&asset_id);
    assert_eq!(history.len(), 2);
    assert_eq!(history.get(0).unwrap().version, 1);
    assert_eq!(history.get(1).unwrap().version, 2);
}

#[test]
#[should_panic]
fn test_publish_update_rejects_non_owner() {
    let (env, admin, contract_id) = setup();
    let stranger = Address::generate(&env);
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);
    let asset_id = client.list_asset(
        &admin,
        &String::from_str(&env, "Owned Asset"),
        &String::from_str(&env, "Original"),
        &AssetType::Prompt,
        &LicenseType::Perpetual,
        &1,
    );
    client.publish_update(
        &stranger,
        &asset_id,
        &String::from_str(&env, "Unauthorized"),
    );
}

#[test]
#[should_panic]
fn test_publish_update_rejects_missing_asset() {
    let (env, admin, contract_id) = setup();
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);
    client.publish_update(&admin, &999, &String::from_str(&env, "Missing"));
}

#[test]
fn test_history_retains_latest_five_versions() {
    let (env, admin, contract_id) = setup();
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);
    let asset_id = client.list_asset(
        &admin,
        &String::from_str(&env, "Frequently Updated"),
        &String::from_str(&env, "v1"),
        &AssetType::Workflow,
        &LicenseType::UsageBased,
        &1,
    );

    for description in ["v2", "v3", "v4", "v5", "v6", "v7"] {
        client.publish_update(&admin, &asset_id, &String::from_str(&env, description));
    }

    let history = client.get_asset_history(&asset_id);
    assert_eq!(history.len(), 5);
    assert_eq!(history.get(0).unwrap().version, 3);
    assert_eq!(history.get(4).unwrap().version, 7);
    assert!(client.get_asset_version(&asset_id, &1).is_none());
    assert!(client.get_asset_version(&asset_id, &2).is_none());
    for version in 3..=7 {
        assert!(client.get_asset_version(&asset_id, &version).is_some());
    }
}

#[test]
#[should_panic]
fn test_publish_update_rejects_version_overflow() {
    let (env, admin, contract_id) = setup();
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);
    let asset_id = client.list_asset(
        &admin,
        &String::from_str(&env, "Overflow Asset"),
        &String::from_str(&env, "At max"),
        &AssetType::Dataset,
        &LicenseType::OpenSource,
        &0,
    );

    env.as_contract(&contract_id, || {
        let mut assets: Map<u64, IntelligenceAsset> =
            env.storage().persistent().get(&ASSETS_V2).unwrap();
        let mut asset = assets.get(asset_id).unwrap();
        asset.version = u32::MAX;
        assets.set(asset_id, asset.clone());
        env.storage().persistent().set(&ASSETS_V2, &assets);
        let history = Vec::from_array(&env, [snapshot(&asset, asset.created_at)]);
        store_history(&env, asset_id, &history);
    });

    client.publish_update(&admin, &asset_id, &String::from_str(&env, "Overflow"));
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
            );
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
        );

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
        );

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
        );

    assert!(!client.has_license(&buyer, &asset_id));

    let license = client.purchase_license(&buyer, &asset_id, &token_addr);
    assert_eq!(license.asset_id, asset_id);
    assert_eq!(license.asset_version, 1);
    assert!(client.has_license(&buyer, &asset_id));
}

#[test]
fn test_purchase_license_pins_current_and_retained_versions() {
    let (env, admin, contract_id) = setup();
    let current_buyer = Address::generate(&env);
    let historical_buyer = Address::generate(&env);
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);
    let (token_addr, token_sac) = create_token(&env, &current_buyer);
    token_sac.mint(&current_buyer, &10_000_000);
    token_sac.mint(&historical_buyer, &10_000_000);

    let asset_id = client.list_asset(
        &admin,
        &String::from_str(&env, "Purchasable Versions"),
        &String::from_str(&env, "v1"),
        &AssetType::Tool,
        &LicenseType::Perpetual,
        &1_000_000,
    );
    client.publish_update(&admin, &asset_id, &String::from_str(&env, "v2"));
    client.publish_update(&admin, &asset_id, &String::from_str(&env, "v3"));

    let current = client.purchase_license(&current_buyer, &asset_id, &token_addr);
    assert_eq!(current.asset_version, 3);
    assert_eq!(
        client
            .get_license(&current_buyer, &asset_id)
            .unwrap()
            .asset_version,
        3
    );

    let historical = client.purchase_license_version(&historical_buyer, &asset_id, &2, &token_addr);
    assert_eq!(historical.asset_version, 2);
}

fn setup_versioned_purchase() -> (Env, Address, Address, Address, Address, u64) {
    let (env, admin, contract_id) = setup();
    let buyer = Address::generate(&env);
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);
    let (token_addr, token_sac) = create_token(&env, &buyer);
    token_sac.mint(&buyer, &50_000_000);
    let asset_id = client.list_asset(
        &admin,
        &String::from_str(&env, "Version Validation"),
        &String::from_str(&env, "v1"),
        &AssetType::Prompt,
        &LicenseType::Perpetual,
        &1,
    );
    (env, admin, contract_id, buyer, token_addr, asset_id)
}

#[test]
#[should_panic]
fn test_purchase_license_version_rejects_zero() {
    let (env, _admin, contract_id, buyer, token, asset_id) = setup_versioned_purchase();
    MarketplaceContractClient::new(&env, &contract_id)
        .purchase_license_version(&buyer, &asset_id, &0, &token);
}

#[test]
#[should_panic]
fn test_purchase_license_version_rejects_future_version() {
    let (env, _admin, contract_id, buyer, token, asset_id) = setup_versioned_purchase();
    MarketplaceContractClient::new(&env, &contract_id)
        .purchase_license_version(&buyer, &asset_id, &2, &token);
}

#[test]
#[should_panic]
fn test_purchase_license_version_rejects_evicted_version() {
    let (env, admin, contract_id, buyer, token, asset_id) = setup_versioned_purchase();
    let client = MarketplaceContractClient::new(&env, &contract_id);
    for description in ["v2", "v3", "v4", "v5", "v6"] {
        client.publish_update(&admin, &asset_id, &String::from_str(&env, description));
    }
    client.purchase_license_version(&buyer, &asset_id, &1, &token);
}

#[test]
#[should_panic]
fn test_purchase_license_version_rejects_missing_asset() {
    let (env, _admin, contract_id) = setup();
    let buyer = Address::generate(&env);
    let token = Address::generate(&env);
    MarketplaceContractClient::new(&env, &contract_id)
        .purchase_license_version(&buyer, &999, &1, &token);
}

#[test]
#[should_panic]
fn test_purchase_license_version_rejects_inactive_asset() {
    let (env, admin, contract_id, buyer, token, asset_id) = setup_versioned_purchase();
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.delist_asset(&admin, &asset_id);
    client.purchase_license_version(&buyer, &asset_id, &1, &token);
}

#[test]
#[should_panic]
fn test_purchase_license_version_rejects_owner_purchase() {
    let (env, admin, contract_id) = setup();
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);
    let (token, _token_client) = create_token(&env, &admin);
    let asset_id = client.list_asset(
        &admin,
        &String::from_str(&env, "Owner Asset"),
        &String::from_str(&env, "v1"),
        &AssetType::Prompt,
        &LicenseType::Perpetual,
        &1,
    );
    client.purchase_license_version(&admin, &asset_id, &1, &token);
}

#[test]
fn test_legacy_asset_migrates_to_version_one_without_deletion() {
    let (env, admin, contract_id) = setup();
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);
    let legacy = LegacyIntelligenceAsset {
        id: 1,
        owner: admin.clone(),
        name: String::from_str(&env, "Legacy Asset"),
        description: String::from_str(&env, "Legacy description"),
        asset_type: AssetType::Prompt,
        license: LicenseType::Perpetual,
        price: 10,
        usage_count: 4,
        is_active: true,
        created_at: 123,
    };
    env.as_contract(&contract_id, || {
        let mut assets = Map::new(&env);
        assets.set(1u64, legacy);
        env.storage().persistent().set(&ASSETS, &assets);
    });

    let migrated = client.get_asset(&1).unwrap();
    assert_eq!(migrated.version, 1);
    assert_eq!(client.get_asset_history(&1).get(0).unwrap().updated_at, 123);
    env.as_contract(&contract_id, || {
        assert!(env.storage().persistent().has(&ASSETS));
        assert!(env.storage().persistent().has(&ASSETS_V2));
    });
}

#[test]
fn test_legacy_asset_supports_publish_update_and_current_purchase() {
    let (env, admin, contract_id) = setup();
    let buyer = Address::generate(&env);
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);
    let (token, token_client) = create_token(&env, &buyer);
    token_client.mint(&buyer, &100);

    let legacy = LegacyIntelligenceAsset {
        id: 1,
        owner: admin.clone(),
        name: String::from_str(&env, "Legacy Updatable Asset"),
        description: String::from_str(&env, "legacy v1"),
        asset_type: AssetType::Prompt,
        license: LicenseType::Perpetual,
        price: 10,
        usage_count: 4,
        is_active: true,
        created_at: 123,
    };
    env.as_contract(&contract_id, || {
        let mut assets = Map::new(&env);
        assets.set(1u64, legacy);
        env.storage().persistent().set(&ASSETS, &assets);
    });

    client.publish_update(&admin, &1, &String::from_str(&env, "migrated version two"));
    let updated = client.get_asset(&1).unwrap();
    assert_eq!(updated.version, 2);
    assert_eq!(updated.usage_count, 4);
    assert_eq!(client.get_asset_history(&1).len(), 2);

    let license = client.purchase_license(&buyer, &1, &token);
    assert_eq!(license.asset_version, 2);
    assert_eq!(client.get_asset(&1).unwrap().usage_count, 5);
}

#[test]
fn test_asset_migration_is_idempotent_and_v2_takes_precedence() {
    let (env, admin, contract_id) = setup();
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);
    let legacy = LegacyIntelligenceAsset {
        id: 1,
        owner: admin,
        name: String::from_str(&env, "Legacy Asset"),
        description: String::from_str(&env, "legacy description"),
        asset_type: AssetType::Dataset,
        license: LicenseType::OpenSource,
        price: 0,
        usage_count: 2,
        is_active: true,
        created_at: 321,
    };
    env.as_contract(&contract_id, || {
        let mut assets = Map::new(&env);
        assets.set(1u64, legacy);
        env.storage().persistent().set(&ASSETS, &assets);
    });

    let first = client.get_asset(&1).unwrap();
    let second = client.get_asset(&1).unwrap();
    assert_eq!(first.version, 1);
    assert_eq!(second.version, 1);
    assert_eq!(client.get_asset_history(&1).len(), 1);

    env.as_contract(&contract_id, || {
        let assets: Map<u64, IntelligenceAsset> =
            env.storage().persistent().get(&ASSETS_V2).unwrap();
        assert_eq!(assets.len(), 1);

        let mut v2 = assets.get(1).unwrap();
        v2.version = 2;
        v2.description = String::from_str(&env, "authoritative v2");
        store_v2_asset(&env, &v2);
    });

    let preferred = client.get_asset(&1).unwrap();
    assert_eq!(preferred.version, 2);
    assert_eq!(
        preferred.description,
        String::from_str(&env, "authoritative v2")
    );
}

#[test]
fn test_legacy_license_migrates_to_version_one_without_deletion() {
    let (env, _admin, contract_id) = setup();
    let buyer = Address::generate(&env);
    let legacy = LegacyLicense {
        asset_id: 7,
        buyer: buyer.clone(),
        license_type: LicenseType::UsageBased,
        purchased_at: 456,
        calls_remaining: 12,
    };
    let legacy_key = (LISTINGS, buyer.clone(), 7u64);
    env.as_contract(&contract_id, || {
        env.storage().persistent().set(&legacy_key, &legacy);
    });

    let client = MarketplaceContractClient::new(&env, &contract_id);
    let migrated = client.get_license(&buyer, &7).unwrap();
    assert_eq!(migrated.asset_version, 1);
    assert_eq!(migrated.calls_remaining, 12);
    env.as_contract(&contract_id, || {
        assert!(env.storage().persistent().has(&legacy_key));
        assert!(env
            .storage()
            .persistent()
            .has(&license_v2_key(buyer.clone(), 7)));
    });
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
        );

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

// TODO: add negative test for purchasing own asset (should panic)

// ── Upgrade mechanism ────────────────────────────────────────────────────────

#[test]
fn test_version() {
    let (env, admin, contract_id) = setup();
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);
    assert_eq!(client.version(), 2);
}

#[test]
fn test_get_owner() {
    let (env, admin, contract_id) = setup();
    let client = MarketplaceContractClient::new(&env, &contract_id);
    assert_eq!(client.get_owner(), None);
    client.initialize(&admin);
    assert_eq!(client.get_owner(), Some(admin));
}

#[test]
#[should_panic(expected = "contract not initialized")]
fn test_upgrade_requires_initialization() {
    let (env, _admin, contract_id) = setup();
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.upgrade(&BytesN::from_array(&env, &[0u8; 32]));
}

#[test]
fn test_upgrade_with_unknown_wasm_fails() {
    let (env, admin, contract_id) = setup();
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);

    // Hash of WASM that was never uploaded — the host must reject it,
    // leaving the current code in place.
    let bogus = BytesN::from_array(&env, &[7u8; 32]);
    assert!(client.try_upgrade(&bogus).is_err());
    assert_eq!(client.version(), 2);
}

#[test]
fn test_upgrade_requires_owner_auth() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let contract_id = env.register(MarketplaceContract, ());
    let client = MarketplaceContractClient::new(&env, &contract_id);

    // Only initialize is authorized; upgrade gets no signature.
    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "initialize",
            args: (admin.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.initialize(&admin);

    let bogus = BytesN::from_array(&env, &[7u8; 32]);
    assert!(client.try_upgrade(&bogus).is_err());
}
// ── Sealed-Bid Auction tests ──────────────────────────────────────────────────

fn set_ledger(env: &Env, seq: u32) {
    env.ledger().with_mut(|l| l.sequence_number = seq);
}

/// Canonical bid commitment hash: sha256(amount_be_bytes || salt).
fn bid_hash(env: &Env, amount: i128, salt: [u8; 32]) -> BytesN<32> {
    let mut input = Bytes::new(env);
    input.append(&Bytes::from_slice(env, &amount.to_be_bytes()));
    input.append(&Bytes::from_slice(env, &salt));
    env.crypto().sha256(&input).to_bytes()
}

fn salt_of(seed: u8) -> [u8; 32] {
    [seed; 32]
}

/// Mint `amount` of the SAC at `token` to `to`.
fn mint(env: &Env, token: &Address, to: &Address, amount: i128) {
    token::StellarAssetClient::new(env, token).mint(to, &amount);
}

/// Read the balance of `who` on the SAC at `token`.
fn balance(env: &Env, token: &Address, who: &Address) -> i128 {
    token::Client::new(env, token).balance(who)
}

/// List an asset as `seller` and open an auction for it at the current ledger.
fn open_auction_for(
    env: &Env,
    client: &MarketplaceContractClient,
    seller: &Address,
    capacity: u32,
    min_bid: i128,
    duration: u32,
) -> u64 {
    let asset_id = client.list_asset(
        seller,
        &String::from_str(env, "Auction Asset"),
        &String::from_str(env, "Capacity-constrained intelligence asset"),
        &AssetType::Tool,
        &LicenseType::Perpetual,
        &min_bid,
    );
    client.open_auction(seller, &asset_id, &capacity, &min_bid, &duration)
}

/// Setup: env at ledger 100, seller, token, listed asset, open auction.
/// Returns (env, seller, token, auction_id, contract_id).
fn auction_fixture(
    capacity: u32,
    min_bid: i128,
    duration: u32,
) -> (Env, Address, Address, u64, Address) {
    let (env, admin, contract_id) = setup();
    set_ledger(&env, 100);
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);
    let (token, _) = create_token(&env, &admin);
    let auction_id = open_auction_for(&env, &client, &admin, capacity, min_bid, duration);
    (env, admin, token, auction_id, contract_id)
}

#[test]
fn test_open_auction_creates_escrow_and_emits_event() {
    let (env, admin, contract_id) = setup();
    set_ledger(&env, 100);
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);
    let asset_id = client.list_asset(
        &admin,
        &String::from_str(&env, "Auction Asset"),
        &String::from_str(&env, "Capacity constrained"),
        &AssetType::Tool,
        &LicenseType::Perpetual,
        &5_000_000,
    );

    let auction_id = client.open_auction(&admin, &asset_id, &5, &1_000, &10);

    // Inspect the AUCT_OPEN event before any further contract call, since
    // each invocation resets the event log.
    let events = env.events().all();
    let (_, topics, data) = events.last().unwrap();
    let expected_topics = vec![
        &env,
        symbol_short!("AUCT_OPEN").into_val(&env),
        admin.into_val(&env),
    ];
    assert_eq!(topics, expected_topics);
    let (ev_auction, ev_asset, ev_capacity, ev_min_bid, ev_duration) =
        <(u64, u64, u32, i128, u32)>::from_val(&env, &data);
    assert_eq!(
        (ev_auction, ev_asset, ev_capacity, ev_min_bid, ev_duration),
        (auction_id, asset_id, 5, 1_000, 10)
    );

    let auction = client.get_auction(&auction_id).unwrap();
    assert_eq!(auction.id, auction_id);
    assert_eq!(auction.seller, admin);
    assert_eq!(auction.asset_id, asset_id);
    assert_eq!(auction.capacity, 5);
    assert_eq!(auction.min_bid, 1_000);
    assert_eq!(auction.duration_ledgers, 10);
    assert_eq!(auction.open_ledger, 100);
    assert_eq!(auction.phase, AuctionPhase::Commit);
    assert_eq!(auction.reveal_end, 0);
    assert_eq!(auction.token, None);
    assert_eq!(auction.revealed.len(), 0);
}

#[test]
fn test_open_auction_rejects_zero_capacity() {
    let (env, admin, contract_id) = setup();
    set_ledger(&env, 100);
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);
    let asset_id = client.list_asset(
        &admin,
        &String::from_str(&env, "Auction Asset"),
        &String::from_str(&env, "desc"),
        &AssetType::Tool,
        &LicenseType::Perpetual,
        &1_000,
    );
    let result = client.try_open_auction(&admin, &asset_id, &0, &1_000, &10);
    assert_eq!(
        result.unwrap_err().unwrap(),
        MarketplaceError::InvalidAuctionParams
    );
}

#[test]
fn test_open_auction_rejects_zero_duration() {
    let (env, admin, contract_id) = setup();
    set_ledger(&env, 100);
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);
    let asset_id = client.list_asset(
        &admin,
        &String::from_str(&env, "Auction Asset"),
        &String::from_str(&env, "desc"),
        &AssetType::Tool,
        &LicenseType::Perpetual,
        &1_000,
    );
    let result = client.try_open_auction(&admin, &asset_id, &3, &1_000, &0);
    assert_eq!(
        result.unwrap_err().unwrap(),
        MarketplaceError::InvalidAuctionParams
    );
}

#[test]
fn test_open_auction_rejects_non_owner() {
    let (env, admin, contract_id) = setup();
    set_ledger(&env, 100);
    let stranger = Address::generate(&env);
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);
    let asset_id = client.list_asset(
        &admin,
        &String::from_str(&env, "Auction Asset"),
        &String::from_str(&env, "desc"),
        &AssetType::Tool,
        &LicenseType::Perpetual,
        &1_000,
    );
    let result = client.try_open_auction(&stranger, &asset_id, &3, &1_000, &10);
    assert_eq!(result.unwrap_err().unwrap(), MarketplaceError::NotOwner);
}

#[test]
fn test_open_auction_rejects_missing_asset() {
    let (env, admin, contract_id) = setup();
    set_ledger(&env, 100);
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);
    let result = client.try_open_auction(&admin, &999, &3, &1_000, &10);
    assert_eq!(result.unwrap_err().unwrap(), MarketplaceError::AssetNotFound);
}

#[test]
fn test_commit_bid_stores_hash_only_no_amount_leak() {
    let (env, _seller, token, auction_id, contract_id) = auction_fixture(5, 1_000, 10);
    let client = MarketplaceContractClient::new(&env, &contract_id);
    let bidder = Address::generate(&env);
    mint(&env, &token, &bidder, 100_000);
    let before = balance(&env, &token, &bidder);

    let hash = bid_hash(&env, 5_000, salt_of(1));
    client.commit_bid(&bidder, &auction_id, &hash);

    // Inspect the COMMITTED event before any further contract call, since
    // each invocation resets the event log.
    let events = env.events().all();
    let (_, topics, data) = events.last().unwrap();
    let expected_topics = vec![
        &env,
        symbol_short!("COMMITTED").into_val(&env),
        bidder.into_val(&env),
    ];
    assert_eq!(topics, expected_topics);
    assert_eq!(<u64>::from_val(&env, &data), auction_id);

    // The commitment is a hash — no bid amount is observable: no bid record,
    // no funds moved, and the only event is the (auction, bidder) pair.
    assert!(client.get_bid(&auction_id, &bidder).is_none());
    assert_eq!(balance(&env, &token, &bidder), before);
}

#[test]
fn test_commit_bid_rejects_missing_auction() {
    let (env, _seller, _token, _auction_id, contract_id) = auction_fixture(5, 1_000, 10);
    let client = MarketplaceContractClient::new(&env, &contract_id);
    let bidder = Address::generate(&env);
    let hash = bid_hash(&env, 5_000, salt_of(1));
    let result = client.try_commit_bid(&bidder, &999, &hash);
    assert_eq!(result.unwrap_err().unwrap(), MarketplaceError::AuctionNotFound);
}

#[test]
fn test_begin_reveal_requires_commit_window_elapsed() {
    let (env, admin, contract_id) = setup();
    set_ledger(&env, 100);
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);
    let auction_id = open_auction_for(&env, &client, &admin, 5, 1_000, 10);

    // Commit window still open: [100, 110)
    let early = client.try_begin_reveal(&auction_id);
    assert_eq!(
        early.unwrap_err().unwrap(),
        MarketplaceError::AuctionPhaseError
    );

    // Window closed: begin_reveal opens the reveal window at ledger 110.
    set_ledger(&env, 110);
    let reveal_end = client.begin_reveal(&auction_id);
    assert_eq!(reveal_end, 120);
    let auction = client.get_auction(&auction_id).unwrap();
    assert_eq!(auction.phase, AuctionPhase::Reveal);
    assert_eq!(auction.reveal_end, 120);
}

#[test]
fn test_commit_bid_rejects_after_reveal_begins() {
    let (env, admin, contract_id) = setup();
    set_ledger(&env, 100);
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);
    let auction_id = open_auction_for(&env, &client, &admin, 5, 1_000, 10);
    set_ledger(&env, 110);
    client.begin_reveal(&auction_id);

    let bidder = Address::generate(&env);
    let hash = bid_hash(&env, 5_000, salt_of(1));
    let result = client.try_commit_bid(&bidder, &auction_id, &hash);
    assert_eq!(
        result.unwrap_err().unwrap(),
        MarketplaceError::AuctionPhaseError
    );
}

#[test]
fn test_reveal_bid_rejects_uncommitted_bidder() {
    let (env, _seller, token, auction_id, contract_id) = auction_fixture(5, 1_000, 10);
    let client = MarketplaceContractClient::new(&env, &contract_id);
    set_ledger(&env, 110);
    client.begin_reveal(&auction_id);

    let bidder = Address::generate(&env);
    let result = client.try_reveal_bid(
        &bidder,
        &auction_id,
        &5_000,
        &BytesN::from_array(&env, &salt_of(1)),
        &token,
    );
    assert_eq!(result.unwrap_err().unwrap(), MarketplaceError::BidNotCommitted);
}

#[test]
fn test_reveal_bid_rejects_commitment_mismatch() {
    let (env, _seller, token, auction_id, contract_id) = auction_fixture(5, 1_000, 10);
    let client = MarketplaceContractClient::new(&env, &contract_id);

    let bidder = Address::generate(&env);
    let hash = bid_hash(&env, 5_000, salt_of(1));
    client.commit_bid(&bidder, &auction_id, &hash);

    set_ledger(&env, 110);
    client.begin_reveal(&auction_id);

    // Wrong salt (but same amount): hash does not match.
    let wrong_salt = client.try_reveal_bid(
        &bidder,
        &auction_id,
        &5_000,
        &BytesN::from_array(&env, &salt_of(2)),
        &token,
    );
    assert_eq!(
        wrong_salt.unwrap_err().unwrap(),
        MarketplaceError::CommitmentMismatch
    );

    // Right salt but wrong amount: hash does not match either.
    let wrong_amount = client.try_reveal_bid(
        &bidder,
        &auction_id,
        &6_000,
        &BytesN::from_array(&env, &salt_of(1)),
        &token,
    );
    assert_eq!(
        wrong_amount.unwrap_err().unwrap(),
        MarketplaceError::CommitmentMismatch
    );
}

#[test]
fn test_reveal_bid_rejects_below_min_bid() {
    let (env, _seller, token, auction_id, contract_id) = auction_fixture(5, 1_000, 10);
    let client = MarketplaceContractClient::new(&env, &contract_id);

    let bidder = Address::generate(&env);
    let hash = bid_hash(&env, 500, salt_of(1));
    client.commit_bid(&bidder, &auction_id, &hash);

    set_ledger(&env, 110);
    client.begin_reveal(&auction_id);
    let result = client.try_reveal_bid(
        &bidder,
        &auction_id,
        &500,
        &BytesN::from_array(&env, &salt_of(1)),
        &token,
    );
    assert_eq!(
        result.unwrap_err().unwrap(),
        MarketplaceError::InvalidBidAmount
    );
}

#[test]
fn test_reveal_bid_rejects_during_commit_phase() {
    let (env, _seller, token, auction_id, contract_id) = auction_fixture(5, 1_000, 10);
    let client = MarketplaceContractClient::new(&env, &contract_id);

    let bidder = Address::generate(&env);
    let hash = bid_hash(&env, 5_000, salt_of(1));
    client.commit_bid(&bidder, &auction_id, &hash);

    // Reveal while still in the commit window (ledger 100 < 110).
    let result = client.try_reveal_bid(
        &bidder,
        &auction_id,
        &5_000,
        &BytesN::from_array(&env, &salt_of(1)),
        &token,
    );
    assert_eq!(
        result.unwrap_err().unwrap(),
        MarketplaceError::AuctionPhaseError
    );
}

#[test]
fn test_reveal_bid_rejects_double_reveal() {
    let (env, _seller, token, auction_id, contract_id) = auction_fixture(5, 1_000, 10);
    let client = MarketplaceContractClient::new(&env, &contract_id);

    let bidder = Address::generate(&env);
    mint(&env, &token, &bidder, 100_000);
    let before = balance(&env, &token, &bidder);

    let hash = bid_hash(&env, 5_000, salt_of(1));
    client.commit_bid(&bidder, &auction_id, &hash);

    set_ledger(&env, 110);
    client.begin_reveal(&auction_id);
    client.reveal_bid(
        &bidder,
        &auction_id,
        &5_000,
        &BytesN::from_array(&env, &salt_of(1)),
        &token,
    );

    let second = client.try_reveal_bid(
        &bidder,
        &auction_id,
        &5_000,
        &BytesN::from_array(&env, &salt_of(1)),
        &token,
    );
    assert_eq!(
        second.unwrap_err().unwrap(),
        MarketplaceError::BidAlreadyRevealed
    );

    // Funds locked exactly once — no double charge.
    assert_eq!(balance(&env, &token, &bidder), before - 5_000);
}

#[test]
fn test_reveal_after_window_closed_rejected() {
    let (env, _seller, token, auction_id, contract_id) = auction_fixture(5, 1_000, 20);
    let client = MarketplaceContractClient::new(&env, &contract_id);

    let bidder = Address::generate(&env);
    mint(&env, &token, &bidder, 100_000);
    let hash = bid_hash(&env, 5_000, salt_of(1));
    client.commit_bid(&bidder, &auction_id, &hash);

    set_ledger(&env, 120);
    client.begin_reveal(&auction_id); // reveal_end = 140

    // Reveal just before the close: 134 < 140, and 134 >= 135 is false, so no
    // anti-sniping extension.
    set_ledger(&env, 134);
    client.reveal_bid(
        &bidder,
        &auction_id,
        &5_000,
        &BytesN::from_array(&env, &salt_of(1)),
        &token,
    );

    // After the window closed, revealing again is rejected.
    set_ledger(&env, 141);
    let late = client.try_reveal_bid(
        &bidder,
        &auction_id,
        &5_000,
        &BytesN::from_array(&env, &salt_of(1)),
        &token,
    );
    assert_eq!(
        late.unwrap_err().unwrap(),
        MarketplaceError::AuctionPhaseError
    );
}

#[test]
fn test_settle_rejects_before_reveal_window_ends() {
    let (env, _seller, token, auction_id, contract_id) = auction_fixture(5, 1_000, 20);
    let client = MarketplaceContractClient::new(&env, &contract_id);

    let bidder = Address::generate(&env);
    mint(&env, &token, &bidder, 100_000);
    let hash = bid_hash(&env, 5_000, salt_of(1));
    client.commit_bid(&bidder, &auction_id, &hash);

    set_ledger(&env, 120);
    client.begin_reveal(&auction_id); // reveal_end = 140
    set_ledger(&env, 130);
    client.reveal_bid(
        &bidder,
        &auction_id,
        &5_000,
        &BytesN::from_array(&env, &salt_of(1)),
        &token,
    );

    // Still inside the reveal window.
    let early = client.try_settle_auction(&auction_id);
    assert_eq!(
        early.unwrap_err().unwrap(),
        MarketplaceError::AuctionPhaseError
    );

    set_ledger(&env, 140);
    let winners = client.settle_auction(&auction_id);
    assert_eq!(winners.len(), 1);
    assert_eq!(winners.get(0).unwrap(), bidder);
}

#[test]
fn test_settle_rejects_after_settled() {
    let (env, _seller, token, auction_id, contract_id) = auction_fixture(5, 1_000, 10);
    let client = MarketplaceContractClient::new(&env, &contract_id);

    let bidder = Address::generate(&env);
    mint(&env, &token, &bidder, 100_000);
    let hash = bid_hash(&env, 5_000, salt_of(1));
    client.commit_bid(&bidder, &auction_id, &hash);

    set_ledger(&env, 110);
    client.begin_reveal(&auction_id); // reveal_end = 120
    set_ledger(&env, 114);
    client.reveal_bid(
        &bidder,
        &auction_id,
        &5_000,
        &BytesN::from_array(&env, &salt_of(1)),
        &token,
    );

    set_ledger(&env, 120);
    client.settle_auction(&auction_id);
    let again = client.try_settle_auction(&auction_id);
    assert_eq!(
        again.unwrap_err().unwrap(),
        MarketplaceError::AuctionPhaseError
    );
}

#[test]
fn test_full_lifecycle_ten_commit_seven_reveal_capacity_five() {
    let (env, seller, token, auction_id, contract_id) = auction_fixture(5, 1_000, 10);
    let client = MarketplaceContractClient::new(&env, &contract_id);

    // 10 bidders commit during the commit window [100, 110); only 7 reveal.
    let mut bidders: Vec<Address> = Vec::new(&env);
    for i in 0..10u8 {
        let bidder = Address::generate(&env);
        mint(&env, &token, &bidder, 100_000);
        let hash = bid_hash(&env, 10_000 - i as i128 * 1_000, salt_of(i));
        client.commit_bid(&bidder, &auction_id, &hash);
        bidders.push_back(bidder);
    }

    set_ledger(&env, 110);
    client.begin_reveal(&auction_id); // reveal_end = 120

    // Reveal the first 7 (bids 10_000 down to 4_000).
    set_ledger(&env, 114);
    for (i, bidder) in bidders.iter().take(7).enumerate() {
        client.reveal_bid(
            &bidder,
            &auction_id,
            &(10_000 - i as i128 * 1_000),
            &BytesN::from_array(&env, &salt_of(i as u8)),
            &token,
        );
    }

    set_ledger(&env, 120);
    let winners = client.settle_auction(&auction_id);

    // Inspect the AUCT_SETL event before any further contract call.
    let events = env.events().all();
    let (_, topics, _) = events.last().unwrap();
    let expected_topics = vec![&env, symbol_short!("AUCT_SETL").into_val(&env)];
    assert_eq!(topics, expected_topics);

    // Winners are the top 5 bids: 10_000..6_000.
    assert_eq!(winners.len(), 5);
    for i in 0..5usize {
        assert_eq!(winners.get(i as u32).unwrap(), bidders.get(i as u32).unwrap());
    }

    let auction = client.get_auction(&auction_id).unwrap();
    assert_eq!(auction.phase, AuctionPhase::Settled);
    // Uniform second price = the 6th highest revealed bid (5_000).
    assert_eq!(auction.clearing_price, Some(5_000));

    // Each winner escrowed their bid, then received the excess back: net
    // effect is paying exactly the uniform 5_000 clearing price.
    for i in 0..5usize {
        assert_eq!(balance(&env, &token, &bidders.get(i as u32).unwrap()), 95_000);
    }
    // Losers are fully refunded.
    for i in 5..7usize {
        assert_eq!(balance(&env, &token, &bidders.get(i as u32).unwrap()), 100_000);
    }
    // Bidders who committed but never revealed are untouched.
    for i in 7..10usize {
        assert_eq!(balance(&env, &token, &bidders.get(i as u32).unwrap()), 100_000);
    }
    // Seller received 5 winners × 5_000 (on top of the 10_000_000_000 the
    // fixture minted to the admin/seller).
    assert_eq!(balance(&env, &token, &seller), 10_000_000_000 + 25_000);
}

#[test]
fn test_tie_breaking_earlier_reveal_wins() {
    let (env, _seller, token, auction_id, contract_id) = auction_fixture(1, 100, 20);
    let client = MarketplaceContractClient::new(&env, &contract_id);

    let early = Address::generate(&env);
    let late = Address::generate(&env);
    mint(&env, &token, &early, 100_000);
    mint(&env, &token, &late, 100_000);

    let hash = bid_hash(&env, 500, salt_of(1));
    client.commit_bid(&early, &auction_id, &hash);
    let hash = bid_hash(&env, 500, salt_of(2));
    client.commit_bid(&late, &auction_id, &hash);

    set_ledger(&env, 120);
    client.begin_reveal(&auction_id); // reveal_end = 140

    set_ledger(&env, 122);
    client.reveal_bid(
        &early,
        &auction_id,
        &500,
        &BytesN::from_array(&env, &salt_of(1)),
        &token,
    );
    set_ledger(&env, 123);
    client.reveal_bid(
        &late,
        &auction_id,
        &500,
        &BytesN::from_array(&env, &salt_of(2)),
        &token,
    );

    set_ledger(&env, 140);
    let winners = client.settle_auction(&auction_id);

    // Equal bids: the earlier reveal wins; the later bidder is refunded.
    // The winner pays the uniform second price (500) with no excess.
    assert_eq!(winners.len(), 1);
    assert_eq!(winners.get(0).unwrap(), early);
    assert_eq!(balance(&env, &token, &early), 99_500); // paid 500, excess 0
    assert_eq!(balance(&env, &token, &late), 100_000); // full refund
}

#[test]
fn test_capacity_exactly_met_all_win_at_reserve() {
    let (env, seller, token, auction_id, contract_id) = auction_fixture(5, 1_000, 10);
    let client = MarketplaceContractClient::new(&env, &contract_id);

    // Exactly 5 bidders, all reveal. Commits happen in the commit window.
    let mut bidders: Vec<Address> = Vec::new(&env);
    for i in 0..5u8 {
        let bidder = Address::generate(&env);
        mint(&env, &token, &bidder, 100_000);
        let amount = 10_000 - i as i128 * 1_000;
        let hash = bid_hash(&env, amount, salt_of(i));
        client.commit_bid(&bidder, &auction_id, &hash);
        bidders.push_back(bidder);
    }

    set_ledger(&env, 110);
    client.begin_reveal(&auction_id); // reveal_end = 120

    for (i, bidder) in bidders.iter().enumerate() {
        let amount = 10_000 - i as i128 * 1_000;
        set_ledger(&env, 110 + i as u32);
        client.reveal_bid(
            &bidder,
            &auction_id,
            &amount,
            &BytesN::from_array(&env, &salt_of(i as u8)),
            &token,
        );
    }

    set_ledger(&env, 120);
    let winners = client.settle_auction(&auction_id);
    assert_eq!(winners.len(), 5);

    let auction = client.get_auction(&auction_id).unwrap();
    // Fewer than capacity+1 revealed bids → uniform price is the reserve.
    assert_eq!(auction.clearing_price, Some(1_000));

    for (_i, bidder) in bidders.iter().enumerate() {
        // Net of escrow and excess refund, each winner paid the 1_000 reserve
        // price exactly.
        assert_eq!(balance(&env, &token, &bidder), 99_000);
    }
    // Seller receives 5 × 1_000 (on top of the fixture's 10_000_000_000 mint).
    assert_eq!(balance(&env, &token, &seller), 10_000_000_000 + 5_000);
}

#[test]
fn test_anti_sniping_extends_reveal_window() {
    let (env, _seller, token, auction_id, contract_id) = auction_fixture(5, 1_000, 10);
    let client = MarketplaceContractClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    mint(&env, &token, &alice, 100_000);
    mint(&env, &token, &bob, 100_000);

    let hash = bid_hash(&env, 5_000, salt_of(1));
    client.commit_bid(&alice, &auction_id, &hash);
    let hash = bid_hash(&env, 4_000, salt_of(2));
    client.commit_bid(&bob, &auction_id, &hash);

    set_ledger(&env, 110);
    client.begin_reveal(&auction_id); // reveal_end = 120

    // Alice reveals at ledger 116 — inside the final 5 ledgers (>= 115), so
    // the window extends by 5 to 125.
    set_ledger(&env, 116);
    let end = client.reveal_bid(
        &alice,
        &auction_id,
        &5_000,
        &BytesN::from_array(&env, &salt_of(1)),
        &token,
    );
    assert_eq!(end, 125);
    // EXTENDED (then REVEALED) was emitted by this call — the event log
    // resets on every invocation, so inspect it before the next call. The
    // token transfer event precedes the contract's own events.
    let expected_topics = vec![
        &env,
        symbol_short!("EXTENDED").into_val(&env),
        alice.into_val(&env),
    ];
    let events = env.events().all();
    assert!(
        events.iter().any(|(_, topics, _)| topics == expected_topics),
        "EXTENDED event missing"
    );

    // Bob reveals at 121 — the original close (120) has passed, but the
    // extended window is still open. 121 >= 120 extends again to 130.
    set_ledger(&env, 121);
    let end = client.reveal_bid(
        &bob,
        &auction_id,
        &4_000,
        &BytesN::from_array(&env, &salt_of(2)),
        &token,
    );
    assert_eq!(end, 130);
    let expected_topics = vec![
        &env,
        symbol_short!("EXTENDED").into_val(&env),
        bob.into_val(&env),
    ];
    let events = env.events().all();
    assert!(
        events.iter().any(|(_, topics, _)| topics == expected_topics),
        "EXTENDED event missing"
    );

    // Settlement is still blocked inside the extended window.
    set_ledger(&env, 126);
    let early = client.try_settle_auction(&auction_id);
    assert_eq!(
        early.unwrap_err().unwrap(),
        MarketplaceError::AuctionPhaseError
    );

    // The extension actually delayed settlement: at the ORIGINAL close (120)
    // settlement would have happened; now it only settles at 130.
    set_ledger(&env, 130);
    let winners = client.settle_auction(&auction_id);
    assert_eq!(winners.len(), 2);
}

#[test]
fn test_committed_but_never_revealed_forfeits_nothing() {
    let (env, _seller, token, auction_id, contract_id) = auction_fixture(2, 1_000, 10);
    let client = MarketplaceContractClient::new(&env, &contract_id);

    let revealer = Address::generate(&env);
    let no_show = Address::generate(&env);
    mint(&env, &token, &revealer, 100_000);
    mint(&env, &token, &no_show, 100_000);

    let hash = bid_hash(&env, 5_000, salt_of(1));
    client.commit_bid(&revealer, &auction_id, &hash);
    let hash = bid_hash(&env, 9_999, salt_of(2));
    client.commit_bid(&no_show, &auction_id, &hash);

    set_ledger(&env, 110);
    client.begin_reveal(&auction_id); // reveal_end = 120

    set_ledger(&env, 114);
    client.reveal_bid(
        &revealer,
        &auction_id,
        &5_000,
        &BytesN::from_array(&env, &salt_of(1)),
        &token,
    );

    set_ledger(&env, 120);
    let winners = client.settle_auction(&auction_id);
    assert_eq!(winners.len(), 1);
    assert_eq!(winners.get(0).unwrap(), revealer);
    // The no-show bidder did not win...
    let auction = client.get_auction(&auction_id).unwrap();
    assert!(!auction.revealed.contains(&no_show));
    // ...and forfeited nothing: no funds were ever escrowed.
    assert_eq!(balance(&env, &token, &no_show), 100_000);
}

#[test]
fn test_get_bid_returns_revealed_bid() {
    let (env, _seller, token, auction_id, contract_id) = auction_fixture(5, 1_000, 10);
    let client = MarketplaceContractClient::new(&env, &contract_id);

    let bidder = Address::generate(&env);
    mint(&env, &token, &bidder, 100_000);

    let hash = bid_hash(&env, 5_000, salt_of(1));
    client.commit_bid(&bidder, &auction_id, &hash);

    set_ledger(&env, 110);
    client.begin_reveal(&auction_id);
    set_ledger(&env, 114);
    client.reveal_bid(
        &bidder,
        &auction_id,
        &5_000,
        &BytesN::from_array(&env, &salt_of(1)),
        &token,
    );

    let bid = client.get_bid(&auction_id, &bidder).unwrap();
    assert_eq!(bid.amount, 5_000);
    assert_eq!(bid.token, token);
    assert_eq!(bid.revealed_at, 114);
}