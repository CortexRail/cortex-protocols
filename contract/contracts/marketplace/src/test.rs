use super::*;
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _, Ledger as _, MockAuth, MockAuthInvoke},
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
    // The helper is only used from test code, so thread-local std allocations
    // are fine here.
    extern crate std;
    let raw: std::vec::Vec<u8> = std::vec![b'a'; n];
    String::from_bytes(env, &raw)
}

// ── Existing happy-path tests ─────────────────────────────────────────────────

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
        &soroban_sdk::Vec::new(&env),
    );

    assert_eq!(asset_id, 1);

    // Inspect the LISTED event before issuing any further contract call:
    // invocation metering clears prior events at the start of the next one.
    let events = env.events().all();
    assert_eq!(events.len(), 1);
    let (_, topics, data) = events.last().unwrap();
    let expected_topics = vec![
        &env,
        symbol_short!("LISTED").into_val(&env),
        admin.into_val(&env),
    ];
    let emitted = u64::from_val(&env, &data);
    assert_eq!(topics, expected_topics);
    assert_eq!(emitted, asset_id);

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
        &soroban_sdk::Vec::new(&env),
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
        &soroban_sdk::Vec::new(&env),
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
        &soroban_sdk::Vec::new(&env),
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
        &soroban_sdk::Vec::new(&env),
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

        client.list_asset(
            &admin,
            &name,
            &String::from_str(&env, "A test intelligence asset"),
            &AssetType::Workflow,
            &LicenseType::UsageBased,
            &1_000_000i128,
            &soroban_sdk::Vec::new(&env),
        );
    }

    assert_eq!(client.asset_count(), 5);
}

#[test]
fn test_delist_asset() {
    let (env, admin, contract_id) = setup();
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);

    let asset_id = client.list_asset(
        &admin,
        &String::from_str(&env, "Deprecated Evaluator"),
        &String::from_str(&env, "Old evaluator being retired"),
        &AssetType::Evaluator,
        &LicenseType::Perpetual,
        &2_000_000i128,
        &soroban_sdk::Vec::new(&env),
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

    let asset_id = client.list_asset(
        &admin,
        &String::from_str(&env, "Memory System v1"),
        &String::from_str(&env, "Persistent agent memory module"),
        &AssetType::MemorySystem,
        &LicenseType::Subscription,
        &10_000_000i128,
        &soroban_sdk::Vec::new(&env),
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

    let asset_id = client.list_asset(
        &admin,
        &String::from_str(&env, "Reasoning Chain Alpha"),
        &String::from_str(&env, "Multi-step reasoning for legal analysis"),
        &AssetType::ReasoningChain,
        &LicenseType::Perpetual,
        &10_000_000i128,
        &soroban_sdk::Vec::new(&env),
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
        &soroban_sdk::Vec::new(&env),
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
        &soroban_sdk::Vec::new(&env),
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
        &soroban_sdk::Vec::new(&env),
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

    client.list_asset(
        &admin,
        &String::from_str(&env, "Tool Pack"),
        &String::from_str(&env, "Collection of agent tools"),
        &AssetType::Tool,
        &LicenseType::UsageBased,
        &3_000_000i128,
        &soroban_sdk::Vec::new(&env),
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
        &soroban_sdk::Vec::new(&env),
    );

    assert_eq!(result.unwrap_err().unwrap(), MarketplaceError::InvalidPrice);
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
        &soroban_sdk::Vec::new(&env),
    );

    assert_eq!(result.unwrap_err().unwrap(), MarketplaceError::InvalidPrice);
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
        &soroban_sdk::Vec::new(&env),
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
        &soroban_sdk::Vec::new(&env),
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
        &soroban_sdk::Vec::new(&env),
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
        &soroban_sdk::Vec::new(&env),
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
        &soroban_sdk::Vec::new(&env),
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
        &soroban_sdk::Vec::new(&env),
    );

    assert!(result.is_ok());
}

// TODO: add negative test for purchasing own asset (should panic)

// Guard 4 — listing limit (MAX_ASSETS)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_list_asset_rejects_when_limit_reached() {
    let (env, admin, contract_id) = setup();
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);

    env.as_contract(&contract_id, || {
        env.storage().instance().set(&ASSET_COUNT, &MAX_ASSETS);
    });

    let result = client.try_list_asset(
        &admin,
        &String::from_str(&env, "Over Limit"),
        &String::from_str(&env, "Should be rejected"),
        &AssetType::Prompt,
        &LicenseType::Perpetual,
        &1i128,
        &soroban_sdk::Vec::new(&env),
    );

    assert_eq!(
        result.unwrap_err().unwrap(),
        MarketplaceError::AssetLimitReached
    );
}

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
        &soroban_sdk::Vec::new(env),
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
        &soroban_sdk::Vec::new(&env),
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
        &soroban_sdk::Vec::from_array(&env, [String::from_str(&env, "tag")]),
    );
    let result = client.try_open_auction(&admin, &asset_id, &0, &1_000, &10);
    assert_eq!(
        result.unwrap_err().unwrap(),
        MarketplaceError::InvalidAuctionParams
    );
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
            &soroban_sdk::Vec::new(&env),
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
        &soroban_sdk::Vec::new(&env),
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
        &soroban_sdk::Vec::new(&env),
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

fn setup_bond_test() -> (Env, Address, Address, Address, u64, u64, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let seller = Address::generate(&env);
    let buyer = Address::generate(&env);
    let contract_id = env.register(MarketplaceContract, ());
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);
    let tags = vec![&env];
    let asset_id = client.list_asset(
        &seller,
        &String::from_str(&env, "Test Asset"),
        &String::from_str(&env, "Desc"),
        &AssetType::Prompt,
        &LicenseType::Perpetual,
        &1000i128,
        &tags,
    );
    client.post_bond(&seller, &asset_id, &5000i128);
    let (token_addr, _token_client) = create_token(&env, &admin);
    let license = client.purchase_license(&buyer, &asset_id, &token_addr);
    let license_id = license.id;
    (env, admin, seller, buyer, asset_id, license_id, contract_id)
}

// ── Bond & Multi-Round Dispute Game Tests ────────────────────────────────────

#[test]
fn test_post_and_withdraw_bond() {
    let (env, _admin, seller, _buyer, asset_id, _license_id, contract_id) = setup_bond_test();
    let client = MarketplaceContractClient::new(&env, &contract_id);

    let bond = client.get_bond(&asset_id).unwrap();
    assert_eq!(bond.amount, 5000i128);

    client.withdraw_bond(&seller, &asset_id, &2000i128);
    let bond2 = client.get_bond(&asset_id).unwrap();
    assert_eq!(bond2.amount, 3000i128);
}

#[test]
fn test_seller_forfeit_by_silence() {
    let (env, _admin, _seller, buyer, _asset_id, license_id, contract_id) = setup_bond_test();
    let client = MarketplaceContractClient::new(&env, &contract_id);

    let claim_hash = BytesN::from_array(&env, &[1u8; 32]);
    let dispute_id = client.open_dispute(&buyer, &license_id, &claim_hash, &1000i128);

    env.ledger().set_timestamp(200);

    client.resolve(&dispute_id);
    let dsp = client.get_multi_dispute(&dispute_id).unwrap();
    assert_eq!(dsp.outcome, DisputeOutcome::BuyerWins);
    assert!(dsp.resolved);
}

#[test]
fn test_buyer_forfeit_by_non_reveal() {
    let (env, _admin, seller, buyer, _asset_id, license_id, contract_id) = setup_bond_test();
    let client = MarketplaceContractClient::new(&env, &contract_id);

    let claim_hash = BytesN::from_array(&env, &[2u8; 32]);
    let dispute_id = client.open_dispute(&buyer, &license_id, &claim_hash, &1000i128);

    let resp_hash = BytesN::from_array(&env, &[3u8; 32]);
    client.respond(&seller, &dispute_id, &resp_hash);

    env.ledger().set_timestamp(300);

    client.resolve(&dispute_id);
    let dsp = client.get_multi_dispute(&dispute_id).unwrap();
    assert_eq!(dsp.outcome, DisputeOutcome::SellerWins);
}

#[test]
fn test_escalation_bond_doubling() {
    let (env, _admin, _seller, buyer, _asset_id, license_id, contract_id) = setup_bond_test();
    let client = MarketplaceContractClient::new(&env, &contract_id);

    let claim_hash = BytesN::from_array(&env, &[4u8; 32]);
    let dispute_id = client.open_dispute(&buyer, &license_id, &claim_hash, &1000i128);

    client.escalate(&buyer, &dispute_id);
    let dsp = client.get_multi_dispute(&dispute_id).unwrap();
    assert_eq!(dsp.round, 2);
    assert_eq!(dsp.buyer_bond, 2000i128);
    assert_eq!(dsp.seller_bond, 2000i128);
}

#[test]
fn test_slashing_arithmetic_round_1() {
    let (env, _admin, _seller, buyer, _asset_id, license_id, contract_id) = setup_bond_test();
    let client = MarketplaceContractClient::new(&env, &contract_id);

    let claim_hash = BytesN::from_array(&env, &[5u8; 32]);
    let dispute_id = client.open_dispute(&buyer, &license_id, &claim_hash, &1000i128);

    env.ledger().set_timestamp(200);

    let initial_treasury = client.get_treasury_balance();
    client.resolve(&dispute_id);
    let final_treasury = client.get_treasury_balance();

    assert_eq!(final_treasury - initial_treasury, 500i128);
}

#[test]
fn test_slashing_arithmetic_round_2() {
    let (env, _admin, _seller, buyer, _asset_id, license_id, contract_id) = setup_bond_test();
    let client = MarketplaceContractClient::new(&env, &contract_id);

    let claim_hash = BytesN::from_array(&env, &[6u8; 32]);
    let dispute_id = client.open_dispute(&buyer, &license_id, &claim_hash, &1000i128);

    client.escalate(&buyer, &dispute_id);

    env.ledger().set_timestamp(200);
    let initial_treasury = client.get_treasury_balance();
    client.resolve(&dispute_id);
    let final_treasury = client.get_treasury_balance();

    assert_eq!(final_treasury - initial_treasury, 1000i128);
}

#[test]
fn test_frivolous_dispute_costing_buyer_more() {
    let (env, _admin, seller, buyer, _asset_id, license_id, contract_id) = setup_bond_test();
    let client = MarketplaceContractClient::new(&env, &contract_id);

    let salt = BytesN::from_array(&env, &[10u8; 32]);
    let evidence = Bytes::from_array(&env, &[1, 2, 3]);

    let mut payload = Bytes::new(&env);
    payload.append(&evidence);
    payload.append(&Bytes::from(salt.clone()));
    let claim_hash: BytesN<32> = env.crypto().sha256(&payload).into();

    let dispute_id = client.open_dispute(&buyer, &license_id, &claim_hash, &1000i128);
    client.respond(&seller, &dispute_id, &claim_hash);

    client.reveal(&seller, &dispute_id, &evidence, &salt);

    env.ledger().set_timestamp(300);
    client.resolve(&dispute_id);

    let dsp = client.get_multi_dispute(&dispute_id).unwrap();
    assert_eq!(dsp.outcome, DisputeOutcome::SellerWins);
    assert_eq!(dsp.buyer_bond, 1000i128);
}

#[test]
fn test_bond_withdrawal_blocked_by_open_dispute() {
    let (env, _admin, seller, buyer, asset_id, license_id, contract_id) = setup_bond_test();
    let client = MarketplaceContractClient::new(&env, &contract_id);

    let claim_hash = BytesN::from_array(&env, &[7u8; 32]);
    let _dispute_id = client.open_dispute(&buyer, &license_id, &claim_hash, &1000i128);

    let res = client.try_withdraw_bond(&seller, &asset_id, &1000i128);
    assert_eq!(res.unwrap_err().unwrap(), MarketplaceError::BondWithdrawalBlocked.into());
}

#[test]
fn test_arbiter_registration_and_slashing() {
    let (env, admin, _seller, _buyer, _asset_id, _license_id, contract_id) = setup_bond_test();
    let client = MarketplaceContractClient::new(&env, &contract_id);

    let arb = Address::generate(&env);
    client.register_staked_arbiter(&admin, &arb, &10000i128);

    client.slash_arbiter(&admin, &arb, &3000i128);
    assert_eq!(client.get_treasury_balance(), 3000i128);
}

#[test]
fn test_commitment_mismatch_fails_reveal() {
    let (env, _admin, seller, buyer, _asset_id, license_id, contract_id) = setup_bond_test();
    let client = MarketplaceContractClient::new(&env, &contract_id);

    let claim_hash = BytesN::from_array(&env, &[8u8; 32]);
    let dispute_id = client.open_dispute(&buyer, &license_id, &claim_hash, &1000i128);

    client.respond(&seller, &dispute_id, &claim_hash);

    let wrong_salt = BytesN::from_array(&env, &[99u8; 32]);
    let evidence = Bytes::from_array(&env, &[1, 2]);

    let res = client.try_reveal(&seller, &dispute_id, &evidence, &wrong_salt);
    assert_eq!(res.unwrap_err().unwrap(), MarketplaceError::CommitmentMismatch.into());
}

#[test]
fn test_bond_withdrawal_blocked_by_cooldown() {
    let (env, _admin, seller, buyer, asset_id, license_id, contract_id) = setup_bond_test();
    let client = MarketplaceContractClient::new(&env, &contract_id);

    let claim_hash = BytesN::from_array(&env, &[9u8; 32]);
    let dispute_id = client.open_dispute(&buyer, &license_id, &claim_hash, &1000i128);

    env.ledger().set_timestamp(50);
    client.resolve(&dispute_id);

    let res = client.try_withdraw_bond(&seller, &asset_id, &1000i128);
    assert_eq!(res.unwrap_err().unwrap(), MarketplaceError::BondWithdrawalBlocked.into());
}

#[test]
fn test_insufficient_bond_fails_dispute_open() {
    let (env, _admin, _seller, buyer, _asset_id, license_id, contract_id) = setup_bond_test();
    let client = MarketplaceContractClient::new(&env, &contract_id);

    let claim_hash = BytesN::from_array(&env, &[11u8; 32]);
    let res = client.try_open_dispute(&buyer, &license_id, &claim_hash, &10_000i128);
    assert_eq!(res.unwrap_err().unwrap(), MarketplaceError::InsufficientBond.into());
}

#[test]
fn test_multi_round_escalation_to_arbitration() {
    let (env, admin, _seller, buyer, _asset_id, license_id, contract_id) = setup_bond_test();
    let client = MarketplaceContractClient::new(&env, &contract_id);

    let arb = Address::generate(&env);
    client.register_staked_arbiter(&admin, &arb, &10000i128);

    let claim_hash = BytesN::from_array(&env, &[12u8; 32]);
    let dispute_id = client.open_dispute(&buyer, &license_id, &claim_hash, &1000i128);

    client.escalate(&buyer, &dispute_id);
    client.escalate(&buyer, &dispute_id);
    client.escalate(&buyer, &dispute_id);

    client.arbitrate(&arb, &dispute_id, &1u32);
    let dsp = client.get_multi_dispute(&dispute_id).unwrap();
    assert_eq!(dsp.outcome, DisputeOutcome::BuyerWins);
    assert!(dsp.resolved);
}

#[test]
fn test_arbitrate_buyer_wins() {
    let (env, admin, _seller, buyer, _asset_id, license_id, contract_id) = setup_bond_test();
    let client = MarketplaceContractClient::new(&env, &contract_id);

    let arb = Address::generate(&env);
    client.register_staked_arbiter(&admin, &arb, &10000i128);

    let claim_hash = BytesN::from_array(&env, &[13u8; 32]);
    let dispute_id = client.open_dispute(&buyer, &license_id, &claim_hash, &1000i128);

    client.escalate(&buyer, &dispute_id);
    client.escalate(&buyer, &dispute_id);
    client.escalate(&buyer, &dispute_id);

    client.arbitrate(&arb, &dispute_id, &1u32);
    let dsp = client.get_multi_dispute(&dispute_id).unwrap();
    assert_eq!(dsp.outcome, DisputeOutcome::BuyerWins);
}

#[test]
fn test_arbitrate_seller_wins() {
    let (env, admin, _seller, buyer, _asset_id, license_id, contract_id) = setup_bond_test();
    let client = MarketplaceContractClient::new(&env, &contract_id);

    let arb = Address::generate(&env);
    client.register_staked_arbiter(&admin, &arb, &10000i128);

    let claim_hash = BytesN::from_array(&env, &[14u8; 32]);
    let dispute_id = client.open_dispute(&buyer, &license_id, &claim_hash, &1000i128);

    client.escalate(&buyer, &dispute_id);
    client.escalate(&buyer, &dispute_id);
    client.escalate(&buyer, &dispute_id);

    client.arbitrate(&arb, &dispute_id, &2u32);
    let dsp = client.get_multi_dispute(&dispute_id).unwrap();
    assert_eq!(dsp.outcome, DisputeOutcome::SellerWins);
}

#[test]
fn test_arbitrate_non_arbiter_fails() {
    let (env, _admin, _seller, buyer, _asset_id, license_id, contract_id) = setup_bond_test();
    let client = MarketplaceContractClient::new(&env, &contract_id);

    let non_arb = Address::generate(&env);
    let claim_hash = BytesN::from_array(&env, &[15u8; 32]);
    let dispute_id = client.open_dispute(&buyer, &license_id, &claim_hash, &1000i128);

    client.escalate(&buyer, &dispute_id);
    client.escalate(&buyer, &dispute_id);
    client.escalate(&buyer, &dispute_id);

    let res = client.try_arbitrate(&non_arb, &dispute_id, &1u32);
    assert_eq!(res.unwrap_err().unwrap(), MarketplaceError::ArbiterNotFound.into());
}

#[test]
fn test_double_reveal_fails() {
    let (env, _admin, seller, buyer, _asset_id, license_id, contract_id) = setup_bond_test();
    let client = MarketplaceContractClient::new(&env, &contract_id);

    let salt = BytesN::from_array(&env, &[16u8; 32]);
    let evidence = Bytes::from_array(&env, &[10, 20]);

    let mut payload = Bytes::new(&env);
    payload.append(&evidence);
    payload.append(&Bytes::from(salt.clone()));
    let claim_hash: BytesN<32> = env.crypto().sha256(&payload).into();

    let dispute_id = client.open_dispute(&buyer, &license_id, &claim_hash, &1000i128);
    client.respond(&seller, &dispute_id, &claim_hash);

    client.reveal(&buyer, &dispute_id, &evidence, &salt);
    let res = client.try_reveal(&buyer, &dispute_id, &evidence, &salt);
    assert_eq!(res.unwrap_err().unwrap(), MarketplaceError::AlreadyRevealed.into());
}

#[test]
fn test_silence_loses_same_as_responding_loss() {
    let (env, _admin, _seller, buyer, _asset_id, license_id, contract_id) = setup_bond_test();
    let client = MarketplaceContractClient::new(&env, &contract_id);

    let claim_hash = BytesN::from_array(&env, &[17u8; 32]);
    let dispute_id = client.open_dispute(&buyer, &license_id, &claim_hash, &1000i128);

    env.ledger().set_timestamp(200);
    client.resolve(&dispute_id);

    let dsp = client.get_multi_dispute(&dispute_id).unwrap();
    assert_eq!(dsp.outcome, DisputeOutcome::BuyerWins);
    assert_eq!(dsp.seller_bond, 1000i128);
}

#[test]
fn test_treasury_accumulates_slashed_shares() {
    let (env, _admin, _seller, buyer, _asset_id, license_id, contract_id) = setup_bond_test();
    let client = MarketplaceContractClient::new(&env, &contract_id);

    let claim_hash = BytesN::from_array(&env, &[18u8; 32]);
    let dispute_id = client.open_dispute(&buyer, &license_id, &claim_hash, &1000i128);

    env.ledger().set_timestamp(200);
    client.resolve(&dispute_id);

    assert_eq!(client.get_treasury_balance(), 500i128);
}

#[test]
fn test_resolve_twice_fails() {
    let (env, _admin, _seller, buyer, _asset_id, license_id, contract_id) = setup_bond_test();
    let client = MarketplaceContractClient::new(&env, &contract_id);

    let claim_hash = BytesN::from_array(&env, &[19u8; 32]);
    let dispute_id = client.open_dispute(&buyer, &license_id, &claim_hash, &1000i128);

    env.ledger().set_timestamp(200);
    client.resolve(&dispute_id);

    let res = client.try_resolve(&dispute_id);
    assert_eq!(res.unwrap_err().unwrap(), MarketplaceError::DisputeAlreadyResolved.into());
}

include!("test_multisig.rs");
