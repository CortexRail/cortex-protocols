#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Env, Map, String, Symbol, Vec,
};

#[cfg(test)]
mod test;

// ── Storage Keys ────────────────────────────────────────────────────────────

const ASSETS: Symbol = symbol_short!("ASSETS");
const ASSETS_V2: Symbol = symbol_short!("ASSET_V2");
const ASSET_COUNT: Symbol = symbol_short!("A_COUNT");
const LISTINGS: Symbol = symbol_short!("LISTINGS");
const LISTINGS_V2: Symbol = symbol_short!("LIC_V2");
const ASSET_HISTORY: Symbol = symbol_short!("A_HIST");
const OWNER: Symbol = symbol_short!("OWNER");
const HISTORY_LIMIT: u32 = 5;

// ── Data Types ───────────────────────────────────────────────────────────────

/// Categories of intelligence assets that can be traded
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AssetType {
    Prompt,
    Workflow,
    ReasoningChain,
    Dataset,
    Evaluator,
    MemorySystem,
    ModelInstruction,
    Tool,
}

/// Licensing model for an intelligence asset
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LicenseType {
    /// One-time purchase, perpetual use
    Perpetual,
    /// Pay-per-call usage-based billing
    UsageBased,
    /// Time-bound subscription
    Subscription,
    /// Attribution required; derivative works allowed
    OpenSource,
}

/// Core intelligence asset record stored on-chain
#[contracttype]
#[derive(Clone, Debug)]
pub struct IntelligenceAsset {
    pub id: u64,
    pub owner: Address,
    pub name: String,
    pub description: String,
    pub asset_type: AssetType,
    pub license: LicenseType,
    /// Price in stroops (1 XLM = 10_000_000 stroops)
    pub price: i128,
    pub usage_count: u64,
    pub is_active: bool,
    pub created_at: u64,
    pub version: u32,
}

/// A retained description snapshot for a published asset version.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetVersion {
    pub version: u32,
    pub description: String,
    pub updated_at: u64,
}

/// A purchase record / license grant
#[contracttype]
#[derive(Clone, Debug)]
pub struct License {
    pub asset_id: u64,
    pub asset_version: u32,
    pub buyer: Address,
    pub license_type: LicenseType,
    pub purchased_at: u64,
    pub calls_remaining: u64,
}

/// Exact pre-versioning asset encoding retained for storage migration.
#[contracttype]
#[derive(Clone, Debug)]
struct LegacyIntelligenceAsset {
    pub id: u64,
    pub owner: Address,
    pub name: String,
    pub description: String,
    pub asset_type: AssetType,
    pub license: LicenseType,
    pub price: i128,
    pub usage_count: u64,
    pub is_active: bool,
    pub created_at: u64,
}

/// Exact pre-versioning license encoding retained for storage migration.
#[contracttype]
#[derive(Clone, Debug)]
struct LegacyLicense {
    pub asset_id: u64,
    pub buyer: Address,
    pub license_type: LicenseType,
    pub purchased_at: u64,
    pub calls_remaining: u64,
}

fn history_key(asset_id: u64) -> (Symbol, u64) {
    (ASSET_HISTORY, asset_id)
}

fn license_v2_key(buyer: Address, asset_id: u64) -> (Symbol, Address, u64) {
    (LISTINGS_V2, buyer, asset_id)
}

fn snapshot(asset: &IntelligenceAsset, updated_at: u64) -> AssetVersion {
    AssetVersion {
        version: asset.version,
        description: asset.description.clone(),
        updated_at,
    }
}

fn get_v2_asset(env: &Env, asset_id: u64) -> Option<IntelligenceAsset> {
    let assets: Map<u64, IntelligenceAsset> = env
        .storage()
        .persistent()
        .get(&ASSETS_V2)
        .unwrap_or(Map::new(env));
    assets.get(asset_id)
}

fn store_v2_asset(env: &Env, asset: &IntelligenceAsset) {
    let mut assets: Map<u64, IntelligenceAsset> = env
        .storage()
        .persistent()
        .get(&ASSETS_V2)
        .unwrap_or(Map::new(env));
    assets.set(asset.id, asset.clone());
    env.storage().persistent().set(&ASSETS_V2, &assets);
}

fn store_history(env: &Env, asset_id: u64, history: &Vec<AssetVersion>) {
    env.storage()
        .persistent()
        .set(&history_key(asset_id), history);
}

fn ensure_history(env: &Env, asset: &IntelligenceAsset) -> Vec<AssetVersion> {
    let key = history_key(asset.id);
    if let Some(history) = env.storage().persistent().get(&key) {
        return history;
    }

    let history = Vec::from_array(env, [snapshot(asset, asset.created_at)]);
    store_history(env, asset.id, &history);
    history
}

/// Read through V2 storage and lazily, idempotently migrate legacy assets.
fn load_asset(env: &Env, asset_id: u64) -> Option<IntelligenceAsset> {
    if let Some(asset) = get_v2_asset(env, asset_id) {
        ensure_history(env, &asset);
        return Some(asset);
    }

    let legacy_assets: Map<u64, LegacyIntelligenceAsset> = env
        .storage()
        .persistent()
        .get(&ASSETS)
        .unwrap_or(Map::new(env));
    let legacy = legacy_assets.get(asset_id)?;
    let asset = IntelligenceAsset {
        id: legacy.id,
        owner: legacy.owner,
        name: legacy.name,
        description: legacy.description,
        asset_type: legacy.asset_type,
        license: legacy.license,
        price: legacy.price,
        usage_count: legacy.usage_count,
        is_active: legacy.is_active,
        created_at: legacy.created_at,
        version: 1,
    };

    // Legacy state remains untouched. The V2 asset and its version-1 history
    // are fully written before this migration is considered complete.
    store_v2_asset(env, &asset);
    ensure_history(env, &asset);
    Some(asset)
}

fn load_license(env: &Env, buyer: &Address, asset_id: u64) -> Option<License> {
    let v2_key = license_v2_key(buyer.clone(), asset_id);
    if let Some(license) = env.storage().persistent().get(&v2_key) {
        return Some(license);
    }

    let legacy_key = (LISTINGS, buyer.clone(), asset_id);
    let legacy: LegacyLicense = env.storage().persistent().get(&legacy_key)?;
    let license = License {
        asset_id: legacy.asset_id,
        asset_version: 1,
        buyer: legacy.buyer,
        license_type: legacy.license_type,
        purchased_at: legacy.purchased_at,
        calls_remaining: legacy.calls_remaining,
    };
    env.storage().persistent().set(&v2_key, &license);
    Some(license)
}

fn find_asset_version(env: &Env, asset: &IntelligenceAsset, version: u32) -> Option<AssetVersion> {
    let history = ensure_history(env, asset);
    history.iter().find(|entry| entry.version == version)
}

// ── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct MarketplaceContract;

#[contractimpl]
impl MarketplaceContract {
    // ── Admin ─────────────────────────────────────────────────────────────

    /// Initialise the marketplace; caller becomes the admin owner.
    pub fn initialize(env: Env, owner: Address) {
        owner.require_auth();
        env.storage().instance().set(&OWNER, &owner);
        env.storage().instance().set(&ASSET_COUNT, &0u64);
    }

    // ── Asset Management ──────────────────────────────────────────────────

    /// List a new intelligence asset on the marketplace.
    pub fn list_asset(
        env: Env,
        owner: Address,
        name: String,
        description: String,
        asset_type: AssetType,
        license: LicenseType,
        price: i128,
    ) -> u64 {
        owner.require_auth();

        let count: u64 = env.storage().instance().get(&ASSET_COUNT).unwrap_or(0u64);
        let asset_id = count + 1;

        let asset = IntelligenceAsset {
            id: asset_id,
            owner: owner.clone(),
            name,
            description,
            asset_type,
            license,
            price,
            usage_count: 0,
            is_active: true,
            created_at: env.ledger().timestamp(),
            version: 1,
        };

        store_v2_asset(&env, &asset);
        let history = Vec::from_array(&env, [snapshot(&asset, asset.created_at)]);
        store_history(&env, asset_id, &history);
        env.storage().instance().set(&ASSET_COUNT, &asset_id);

        env.events()
            .publish((symbol_short!("LISTED"), owner), asset_id);

        asset_id
    }

    /// Delist / deactivate an asset. Only the owner can do this.
    pub fn delist_asset(env: Env, owner: Address, asset_id: u64) {
        owner.require_auth();

        let mut asset = load_asset(&env, asset_id).expect("asset not found");
        assert!(asset.owner == owner, "not the asset owner");

        asset.is_active = false;
        store_v2_asset(&env, &asset);

        env.events()
            .publish((symbol_short!("DELISTED"), owner), asset_id);
    }

    /// Update the price of a listed asset.
    pub fn update_price(env: Env, owner: Address, asset_id: u64, new_price: i128) {
        owner.require_auth();

        let mut asset = load_asset(&env, asset_id).expect("asset not found");
        assert!(asset.owner == owner, "not the asset owner");
        assert!(asset.is_active, "asset is not active");

        asset.price = new_price;
        store_v2_asset(&env, &asset);
    }

    /// Publish a new description and retain it as the next asset version.
    pub fn publish_update(env: Env, owner: Address, asset_id: u64, new_description: String) {
        owner.require_auth();

        let mut asset = load_asset(&env, asset_id).expect("asset not found");
        assert!(asset.owner == owner, "not the asset owner");

        let old_version = asset.version;
        let new_version = old_version.checked_add(1).expect("version overflow");
        asset.description = new_description;
        asset.version = new_version;

        let mut history = ensure_history(&env, &asset);
        history.push_back(snapshot(&asset, env.ledger().timestamp()));
        while history.len() > HISTORY_LIMIT {
            history.remove(0);
        }

        store_v2_asset(&env, &asset);
        store_history(&env, asset_id, &history);

        env.events().publish(
            (symbol_short!("UPDATED"), owner),
            (asset_id, old_version, new_version),
        );
    }

    // ── Purchasing ────────────────────────────────────────────────────────

    /// Purchase a license for an intelligence asset.
    /// Payment is validated via a pre-authorized token transfer.
    pub fn purchase_license(env: Env, buyer: Address, asset_id: u64, token: Address) -> License {
        let asset = load_asset(&env, asset_id).expect("asset not found");
        let asset_version = asset.version;
        Self::purchase_license_for_version(env, buyer, asset, asset_id, asset_version, token)
    }

    /// Purchase and pin a license to a retained asset version.
    pub fn purchase_license_version(
        env: Env,
        buyer: Address,
        asset_id: u64,
        asset_version: u32,
        token: Address,
    ) -> License {
        assert!(asset_version > 0, "asset version must be positive");
        let asset = load_asset(&env, asset_id).expect("asset not found");
        assert!(
            asset_version <= asset.version,
            "asset version is in the future"
        );
        assert!(
            find_asset_version(&env, &asset, asset_version).is_some(),
            "asset version is not retained"
        );
        Self::purchase_license_for_version(env, buyer, asset, asset_id, asset_version, token)
    }

    fn purchase_license_for_version(
        env: Env,
        buyer: Address,
        mut asset: IntelligenceAsset,
        asset_id: u64,
        asset_version: u32,
        token: Address,
    ) -> License {
        buyer.require_auth();

        assert!(asset.is_active, "asset is not active");
        assert!(buyer != asset.owner, "cannot buy own asset");

        // Transfer payment from buyer to asset owner
        let token_client = soroban_sdk::token::Client::new(&env, &token);
        token_client.transfer(&buyer, &asset.owner, &asset.price);

        let calls_remaining: u64 = match asset.license {
            LicenseType::UsageBased => 100, // default call bundle
            _ => u64::MAX,
        };

        let license = License {
            asset_id,
            asset_version,
            buyer: buyer.clone(),
            license_type: asset.license.clone(),
            purchased_at: env.ledger().timestamp(),
            calls_remaining,
        };

        // Record license
        let license_key = license_v2_key(buyer.clone(), asset_id);
        env.storage().persistent().set(&license_key, &license);

        // Increment usage counter
        asset.usage_count += 1;
        store_v2_asset(&env, &asset);

        env.events()
            .publish((symbol_short!("PURCHASED"), buyer), (asset_id, asset.price));

        license
    }

    // ── Queries ───────────────────────────────────────────────────────────

    /// Retrieve an asset by ID.
    pub fn get_asset(env: Env, asset_id: u64) -> Option<IntelligenceAsset> {
        load_asset(&env, asset_id)
    }

    /// Return the latest five retained versions, oldest to newest.
    pub fn get_asset_history(env: Env, asset_id: u64) -> Vec<AssetVersion> {
        match load_asset(&env, asset_id) {
            Some(asset) => ensure_history(&env, &asset),
            None => Vec::new(&env),
        }
    }

    /// Retrieve a retained asset version by number.
    pub fn get_asset_version(env: Env, asset_id: u64, version: u32) -> Option<AssetVersion> {
        let asset = load_asset(&env, asset_id)?;
        find_asset_version(&env, &asset, version)
    }

    /// Total number of assets ever listed.
    pub fn asset_count(env: Env) -> u64 {
        env.storage().instance().get(&ASSET_COUNT).unwrap_or(0u64)
    }

    /// Check whether a buyer holds a valid license for an asset.
    pub fn has_license(env: Env, buyer: Address, asset_id: u64) -> bool {
        load_license(&env, &buyer, asset_id).is_some()
    }

    /// Get a buyer's license details.
    pub fn get_license(env: Env, buyer: Address, asset_id: u64) -> Option<License> {
        load_license(&env, &buyer, asset_id)
    }
}
