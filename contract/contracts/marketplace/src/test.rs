#![cfg(test)]

use super::*;
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _},
    token, vec, Address, Env, FromVal, IntoVal, Map, String,
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

        client.list_asset(
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

    let asset_id = client.list_asset(
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

    let asset_id = client.list_asset(
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

    let asset_id = client.list_asset(
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

    client.list_asset(
        &admin,
        &String::from_str(&env, "Tool Pack"),
        &String::from_str(&env, "Collection of agent tools"),
        &AssetType::Tool,
        &LicenseType::UsageBased,
        &3_000_000i128,
    );

    assert!(!client.has_license(&stranger, &1));
}

// TODO: add negative test for purchasing own asset (should panic)
