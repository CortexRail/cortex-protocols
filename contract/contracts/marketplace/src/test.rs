#![cfg(test)]

use super::*;
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _, Ledger as _, MockAuth, MockAuthInvoke},
    token, vec, Address, BytesN, Env, FromVal, IntoVal, Map, String,
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
    extern crate std;
    let raw: std::vec::Vec<u8> = std::vec![b'a'; n];
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

    let asset_id = client.list_asset(
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
    assert_eq!(client.version(), 1);
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
    assert_eq!(client.version(), 1);
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

// ── Escrow & Dispute Arbitration Tests ────────────────────────────────────────

fn setup_purchase_scenario() -> (
    Env,
    Address,
    Address,
    Address,
    Address,
    MarketplaceContractClient<'static>,
    Address,
    u64,
) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let seller = Address::generate(&env);
    let buyer = Address::generate(&env);

    let contract_id = env.register(MarketplaceContract, ());
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);

    let (token_address, token_admin) = create_token(&env, &admin);
    token_admin.mint(&buyer, &100_000_000);

    let asset_id = client
        .list_asset(
            &seller,
            &String::from_str(&env, "AI Dataset"),
            &String::from_str(&env, "High quality reasoning chains"),
            &AssetType::Dataset,
            &LicenseType::Perpetual,
            &10_000_000i128,
        );

    let license = client.purchase_license(&buyer, &asset_id, &token_address);

    (
        env,
        admin,
        seller,
        buyer,
        contract_id,
        client,
        token_address,
        license.id,
    )
}

#[test]
fn test_escrow_created_on_purchase() {
    let (_env, _admin, seller, buyer, _contract_id, client, token_address, license_id) =
        setup_purchase_scenario();

    let escrow = client.get_escrow(&license_id).expect("escrow should exist");
    assert_eq!(escrow.license_id, license_id);
    assert_eq!(escrow.buyer, buyer);
    assert_eq!(escrow.seller, seller);
    assert_eq!(escrow.token, token_address);
    assert_eq!(escrow.amount, 10_000_000i128);
    assert_eq!(escrow.status, EscrowStatus::Held);
}

#[test]
fn test_escrow_hold_period_math() {
    let (_env, _admin, _seller, _buyer, _contract_id, client, _token_address, license_id) =
        setup_purchase_scenario();

    let escrow = client.get_escrow(&license_id).unwrap();
    assert_eq!(escrow.hold_until_ledger, escrow.created_ledger + 100);
}

#[test]
fn test_escrow_release_success_after_hold_period() {
    let (env, _admin, seller, _buyer, _contract_id, client, token_address, license_id) =
        setup_purchase_scenario();

    env.ledger().set_sequence_number(150);

    let result = client.try_release_escrow(&license_id);
    assert!(result.is_ok());

    let escrow = client.get_escrow(&license_id).unwrap();
    assert_eq!(escrow.status, EscrowStatus::Released);

    let token_client = token::Client::new(&env, &token_address);
    assert_eq!(token_client.balance(&seller), 10_000_000i128);
}

#[test]
fn test_escrow_release_rejected_before_hold_period_expires() {
    let (env, _admin, _seller, _buyer, _contract_id, client, _token_address, license_id) =
        setup_purchase_scenario();

    env.ledger().set_sequence_number(50);
    let result = client.try_release_escrow(&license_id);
    assert_eq!(
        result.unwrap_err().unwrap(),
        MarketplaceError::DisputeWindowClosed.into()
    );
}

#[test]
fn test_escrow_release_twice_fails() {
    let (env, _admin, _seller, _buyer, _contract_id, client, _token_address, license_id) =
        setup_purchase_scenario();

    env.ledger().set_sequence_number(150);
    client.release_escrow(&license_id);

    let second = client.try_release_escrow(&license_id);
    assert_eq!(
        second.unwrap_err().unwrap(),
        MarketplaceError::EscrowAlreadyReleased.into()
    );
}

#[test]
fn test_raise_dispute_freezes_release() {
    let (env, _admin, _seller, buyer, _contract_id, client, _token_address, license_id) =
        setup_purchase_scenario();

    env.ledger().set_sequence_number(50);
    let evidence_hash = BytesN::from_array(&env, &[1u8; 32]);
    let dispute_id = client
        .raise_purchase_dispute(&buyer, &license_id, &evidence_hash);

    assert_eq!(dispute_id, 1);
    let escrow = client.get_escrow(&license_id).unwrap();
    assert_eq!(escrow.status, EscrowStatus::Disputed);

    let dispute = client.get_dispute(&dispute_id).unwrap();
    assert_eq!(dispute.status, DisputeStatus::Open);
    assert_eq!(dispute.buyer, buyer);
    assert_eq!(dispute.evidence_hash, evidence_hash);
}

#[test]
fn test_disputed_escrow_cannot_be_released() {
    let (env, _admin, _seller, buyer, _contract_id, client, _token_address, license_id) =
        setup_purchase_scenario();

    env.ledger().set_sequence_number(50);
    let evidence_hash = BytesN::from_array(&env, &[1u8; 32]);
    client
        .raise_purchase_dispute(&buyer, &license_id, &evidence_hash);

    env.ledger().set_sequence_number(150);
    let result = client.try_release_escrow(&license_id);
    assert_eq!(
        result.unwrap_err().unwrap(),
        MarketplaceError::EscrowDisputed.into()
    );
}

#[test]
fn test_raise_dispute_after_hold_period_fails() {
    let (env, _admin, _seller, buyer, _contract_id, client, _token_address, license_id) =
        setup_purchase_scenario();

    env.ledger().set_sequence_number(150);
    let evidence_hash = BytesN::from_array(&env, &[1u8; 32]);
    let result = client.try_raise_purchase_dispute(&buyer, &license_id, &evidence_hash);
    assert_eq!(
        result.unwrap_err().unwrap(),
        MarketplaceError::DisputeWindowClosed.into()
    );
}

#[test]
fn test_only_buyer_can_raise_dispute() {
    let (env, _admin, _seller, _buyer, _contract_id, client, _token_address, license_id) =
        setup_purchase_scenario();

    let impostor = Address::generate(&env);
    let evidence_hash = BytesN::from_array(&env, &[1u8; 32]);
    let result = client.try_raise_purchase_dispute(&impostor, &license_id, &evidence_hash);
    assert_eq!(
        result.unwrap_err().unwrap(),
        MarketplaceError::Unauthorized.into()
    );
}

#[test]
fn test_register_arbitrator() {
    let (env, _admin, _seller, _buyer, _contract_id, client, _token_address, _license_id) =
        setup_purchase_scenario();

    let arb1 = Address::generate(&env);
    let arb2 = Address::generate(&env);

    client.register_arbitrator(&arb1);
    client.register_arbitrator(&arb2);

    assert!(client.is_arbitrator(&arb1));
    assert!(client.is_arbitrator(&arb2));

    let arbs = client.get_arbitrators();
    assert_eq!(arbs.len(), 2);
}

#[test]
fn test_non_arbitrator_vote_fails() {
    let (env, _admin, _seller, buyer, _contract_id, client, _token_address, license_id) =
        setup_purchase_scenario();

    let evidence_hash = BytesN::from_array(&env, &[1u8; 32]);
    let dispute_id = client
        .raise_purchase_dispute(&buyer, &license_id, &evidence_hash);

    let fake_arb = Address::generate(&env);
    let votes = vec![&env, (fake_arb, RefundDecision::FullRefund)];

    let result = client.try_resolve_purchase_dispute(&dispute_id, &votes);
    assert_eq!(
        result.unwrap_err().unwrap(),
        MarketplaceError::NotArbitrator.into()
    );
}

#[test]
fn test_committee_vote_full_refund() {
    let (env, _admin, seller, buyer, _contract_id, client, token_address, license_id) =
        setup_purchase_scenario();

    let arb1 = Address::generate(&env);
    let arb2 = Address::generate(&env);
    let arb3 = Address::generate(&env);

    client.register_arbitrator(&arb1);
    client.register_arbitrator(&arb2);
    client.register_arbitrator(&arb3);

    let evidence_hash = BytesN::from_array(&env, &[1u8; 32]);
    let dispute_id = client
        .raise_purchase_dispute(&buyer, &license_id, &evidence_hash);

    let votes = vec![
        &env,
        (arb1.clone(), RefundDecision::FullRefund),
        (arb2.clone(), RefundDecision::FullRefund),
        (arb3.clone(), RefundDecision::ReleaseToSeller),
    ];

    client.resolve_purchase_dispute(&dispute_id, &votes);

    let escrow = client.get_escrow(&license_id).unwrap();
    assert_eq!(escrow.status, EscrowStatus::Resolved);

    let dispute = client.get_dispute(&dispute_id).unwrap();
    assert_eq!(dispute.status, DisputeStatus::Resolved);
    assert_eq!(dispute.decision, RefundDecision::FullRefund);

    let token_client = token::Client::new(&env, &token_address);
    assert_eq!(token_client.balance(&buyer), 100_000_000i128);
    assert_eq!(token_client.balance(&seller), 0i128);
}

#[test]
fn test_committee_vote_release_to_seller() {
    let (env, _admin, seller, buyer, _contract_id, client, token_address, license_id) =
        setup_purchase_scenario();

    let arb1 = Address::generate(&env);
    let arb2 = Address::generate(&env);
    let arb3 = Address::generate(&env);

    client.register_arbitrator(&arb1);
    client.register_arbitrator(&arb2);
    client.register_arbitrator(&arb3);

    let evidence_hash = BytesN::from_array(&env, &[1u8; 32]);
    let dispute_id = client
        .raise_purchase_dispute(&buyer, &license_id, &evidence_hash);

    let votes = vec![
        &env,
        (arb1.clone(), RefundDecision::ReleaseToSeller),
        (arb2.clone(), RefundDecision::ReleaseToSeller),
        (arb3.clone(), RefundDecision::FullRefund),
    ];

    client.resolve_purchase_dispute(&dispute_id, &votes);

    let token_client = token::Client::new(&env, &token_address);
    assert_eq!(token_client.balance(&seller), 10_000_000i128);
    assert_eq!(token_client.balance(&buyer), 90_000_000i128);
}

#[test]
fn test_committee_vote_partial_refund_math() {
    let (env, _admin, seller, buyer, _contract_id, client, token_address, license_id) =
        setup_purchase_scenario();

    let arb1 = Address::generate(&env);
    let arb2 = Address::generate(&env);
    let arb3 = Address::generate(&env);

    client.register_arbitrator(&arb1);
    client.register_arbitrator(&arb2);
    client.register_arbitrator(&arb3);

    let evidence_hash = BytesN::from_array(&env, &[1u8; 32]);
    let dispute_id = client
        .raise_purchase_dispute(&buyer, &license_id, &evidence_hash);

    let votes = vec![
        &env,
        (arb1.clone(), RefundDecision::PartialRefund(5000)),
        (arb2.clone(), RefundDecision::PartialRefund(5000)),
        (arb3.clone(), RefundDecision::FullRefund),
    ];

    client.resolve_purchase_dispute(&dispute_id, &votes);

    let token_client = token::Client::new(&env, &token_address);
    assert_eq!(token_client.balance(&buyer), 95_000_000i128);
    assert_eq!(token_client.balance(&seller), 5_000_000i128);
}

#[test]
fn test_committee_vote_partial_refund_75_percent() {
    let (env, _admin, seller, buyer, _contract_id, client, token_address, license_id) =
        setup_purchase_scenario();

    let arb1 = Address::generate(&env);
    let arb2 = Address::generate(&env);
    let arb3 = Address::generate(&env);

    client.register_arbitrator(&arb1);
    client.register_arbitrator(&arb2);
    client.register_arbitrator(&arb3);

    let evidence_hash = BytesN::from_array(&env, &[1u8; 32]);
    let dispute_id = client
        .raise_purchase_dispute(&buyer, &license_id, &evidence_hash);

    let votes = vec![
        &env,
        (arb1.clone(), RefundDecision::PartialRefund(7500)),
        (arb2.clone(), RefundDecision::PartialRefund(7500)),
        (arb3.clone(), RefundDecision::PartialRefund(7500)),
    ];

    client.resolve_purchase_dispute(&dispute_id, &votes);

    let token_client = token::Client::new(&env, &token_address);
    assert_eq!(token_client.balance(&buyer), 97_500_000i128);
    assert_eq!(token_client.balance(&seller), 2_500_000i128);
}

#[test]
fn test_committee_vote_tie_break() {
    let (env, _admin, seller, buyer, _contract_id, client, token_address, license_id) =
        setup_purchase_scenario();

    let arb1 = Address::generate(&env);
    let arb2 = Address::generate(&env);

    client.register_arbitrator(&arb1);
    client.register_arbitrator(&arb2);

    let evidence_hash = BytesN::from_array(&env, &[1u8; 32]);
    let dispute_id = client
        .raise_purchase_dispute(&buyer, &license_id, &evidence_hash);

    let votes = vec![
        &env,
        (arb1.clone(), RefundDecision::FullRefund),
        (arb2.clone(), RefundDecision::ReleaseToSeller),
    ];

    client.resolve_purchase_dispute(&dispute_id, &votes);

    let token_client = token::Client::new(&env, &token_address);
    assert_eq!(token_client.balance(&buyer), 95_000_000i128);
    assert_eq!(token_client.balance(&seller), 5_000_000i128);
}

#[test]
fn test_resolve_dispute_twice_fails() {
    let (env, _admin, _seller, buyer, _contract_id, client, _token_address, license_id) =
        setup_purchase_scenario();

    let arb1 = Address::generate(&env);
    client.register_arbitrator(&arb1);

    let evidence_hash = BytesN::from_array(&env, &[1u8; 32]);
    let dispute_id = client
        .raise_purchase_dispute(&buyer, &license_id, &evidence_hash);

    let votes = vec![&env, (arb1.clone(), RefundDecision::FullRefund)];
    client.resolve_purchase_dispute(&dispute_id, &votes);

    let second = client.try_resolve_purchase_dispute(&dispute_id, &votes);
    assert_eq!(
        second.unwrap_err().unwrap(),
        MarketplaceError::DisputeAlreadyResolved.into()
    );
}

#[test]
fn test_resolve_nonexistent_dispute_fails() {
    let (env, _admin, _seller, _buyer, _contract_id, client, _token_address, _license_id) =
        setup_purchase_scenario();

    let arb1 = Address::generate(&env);
    client.register_arbitrator(&arb1);

    let votes = vec![&env, (arb1.clone(), RefundDecision::FullRefund)];
    let result = client.try_resolve_purchase_dispute(&999u64, &votes);
    assert_eq!(
        result.unwrap_err().unwrap(),
        MarketplaceError::DisputeNotFound.into()
    );
}

#[test]
fn test_release_nonexistent_escrow_fails() {
    let (env, _admin, _seller, _buyer, _contract_id, client, _token_address, _license_id) =
        setup_purchase_scenario();

    env.ledger().set_sequence_number(150);
    let result = client.try_release_escrow(&999u64);
    assert_eq!(
        result.unwrap_err().unwrap(),
        MarketplaceError::EscrowNotFound.into()
    );
}

#[test]
fn test_invalid_refund_bps_fails() {
    let (env, _admin, _seller, buyer, _contract_id, client, _token_address, license_id) =
        setup_purchase_scenario();

    let arb1 = Address::generate(&env);
    client.register_arbitrator(&arb1);

    let evidence_hash = BytesN::from_array(&env, &[1u8; 32]);
    let dispute_id = client
        .raise_purchase_dispute(&buyer, &license_id, &evidence_hash);

    let votes = vec![&env, (arb1.clone(), RefundDecision::PartialRefund(15000))];
    let result = client.try_resolve_purchase_dispute(&dispute_id, &votes);
    assert_eq!(
        result.unwrap_err().unwrap(),
        MarketplaceError::InvalidRefundBps.into()
    );
}

