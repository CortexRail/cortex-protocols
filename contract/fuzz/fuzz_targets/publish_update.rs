#![no_main]

use libfuzzer_sys::fuzz_target;
use marketplace::{AssetType, LicenseType, MarketplaceContract, MarketplaceContractClient};
use soroban_sdk::{testutils::Address as _, Address, Env, String};

fn byte_at(data: &[u8], index: usize) -> u8 {
    data.get(index).copied().unwrap_or(0)
}

fn description(env: &Env, seed: &[u8], update: u32) -> String {
    let length = (byte_at(seed, update as usize) as usize) % 128;
    let mut bytes = std::vec::Vec::with_capacity(length);
    for index in 0..length {
        let input = byte_at(seed, index + update as usize);
        bytes.push(b' ' + input % 95);
    }
    String::from_bytes(env, &bytes)
}

fuzz_target!(|data: &[u8]| {
    let env = Env::default();
    env.mock_all_auths();
    let owner = Address::generate(&env);
    let stranger = Address::generate(&env);
    let contract_id = env.register(MarketplaceContract, ());
    let client = MarketplaceContractClient::new(&env, &contract_id);

    let asset_id = client.list_asset(
        &owner,
        &String::from_str(&env, "Fuzz Versioned Asset"),
        &String::from_str(&env, "version one"),
        &AssetType::Prompt,
        &LicenseType::Perpetual,
        &1,
    );

    let attempts = (byte_at(data, 0) % 12) as u32;
    let mut successful_updates = 0u32;
    for update in 0..attempts {
        let before = client
            .get_asset(&asset_id)
            .expect("asset must exist before update");
        let caller = if byte_at(data, update as usize + 1) % 3 == 0 {
            stranger.clone()
        } else {
            owner.clone()
        };
        let requested_id = if byte_at(data, update as usize + 2) % 5 == 0 {
            asset_id.saturating_add(1)
        } else {
            asset_id
        };
        let next_description = description(&env, data, update);
        let result = client.try_publish_update(&caller, &requested_id, &next_description);

        if matches!(result, Ok(Ok(()))) {
            successful_updates += 1;
            let after = client
                .get_asset(&asset_id)
                .expect("updated asset must remain retrievable");
            assert_eq!(after.version, before.version + 1);
            assert_eq!(after.description, next_description);
        } else {
            let after = client
                .get_asset(&asset_id)
                .expect("rejected update must preserve the asset");
            assert_eq!(after.version, before.version);
            assert_eq!(after.description, before.description);
        }
    }

    let asset = client
        .get_asset(&asset_id)
        .expect("asset must remain retrievable");
    assert_eq!(asset.version, 1 + successful_updates);

    let history = client.get_asset_history(&asset_id);
    let expected_len = core::cmp::min(asset.version, 5);
    assert_eq!(history.len(), expected_len);
    assert_eq!(
        history.get(expected_len - 1).unwrap().version,
        asset.version
    );
    assert_eq!(
        history.get(0).unwrap().version,
        asset.version - expected_len + 1
    );
});
