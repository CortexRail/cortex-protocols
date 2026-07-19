#![no_std]

mod errors;
pub use errors::MarketplaceError;

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Env, Map, String, Symbol,
};

// ── Governance Limits ────────────────────────────────────────────────────────

/// Maximum number of assets that can ever be listed in one contract instance.
pub const MAX_ASSETS: u64 = 10_000;

/// Maximum byte length of an asset name (UTF-8 encoded).
pub const MAX_NAME_LEN: u32 = 200;

/// Maximum byte length of an asset description (UTF-8 encoded).
pub const MAX_DESC_LEN: u32 = 2_000;

// ── Storage Keys ────────────────────────────────────────────────────────────

const ASSETS: Symbol = symbol_short!("ASSETS");
const ASSET_COUNT: Symbol = symbol_short!("A_COUNT");
const LISTINGS: Symbol = symbol_short!("LISTINGS");
const OWNER: Symbol = symbol_short!("OWNER");

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
}

/// A purchase record / license grant
#[contracttype]
#[derive(Clone, Debug)]
pub struct License {
    pub asset_id: u64,
    pub buyer: Address,
    pub license_type: LicenseType,
    pub purchased_at: u64,
    pub calls_remaining: u64,
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
    ///
    /// # Errors
    /// - [`MarketplaceError::InvalidPrice`]      — `price` must be > 0.
    /// - [`MarketplaceError::InvalidMetadata`]   — `name` must be 1–200 bytes;
    ///                                             `description` must be 1–2 000 bytes.
    /// - [`MarketplaceError::AssetLimitReached`] — contract has already reached
    ///                                             `MAX_ASSETS` (10 000) listings.
    pub fn list_asset(
        env: Env,
        owner: Address,
        name: String,
        description: String,
        asset_type: AssetType,
        license: LicenseType,
        price: i128,
    ) -> Result<u64, MarketplaceError> {
        owner.require_auth();

        // ── Guard 1: price must be positive ──────────────────────────────
        if price <= 0 {
            return Err(MarketplaceError::InvalidPrice);
        }

        // ── Guard 2: name length must be 1–200 bytes ─────────────────────
        let name_len = name.len();
        if name_len == 0 || name_len > MAX_NAME_LEN {
            return Err(MarketplaceError::InvalidMetadata);
        }

        // ── Guard 3: description length must be 1–2 000 bytes ────────────
        let desc_len = description.len();
        if desc_len == 0 || desc_len > MAX_DESC_LEN {
            return Err(MarketplaceError::InvalidMetadata);
        }

        // ── Guard 4: total asset count must not exceed MAX_ASSETS ─────────
        let count: u64 = env
            .storage()
            .instance()
            .get(&ASSET_COUNT)
            .unwrap_or(0u64);

        if count >= MAX_ASSETS {
            return Err(MarketplaceError::AssetLimitReached);
        }

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
        };

        let mut assets: Map<u64, IntelligenceAsset> = env
            .storage()
            .persistent()
            .get(&ASSETS)
            .unwrap_or(Map::new(&env));

        assets.set(asset_id, asset);
        env.storage().persistent().set(&ASSETS, &assets);
        env.storage().instance().set(&ASSET_COUNT, &asset_id);

        env.events().publish((symbol_short!("LISTED"), owner), asset_id);

        Ok(asset_id)
    }

    /// Delist / deactivate an asset. Only the owner can do this.
    pub fn delist_asset(env: Env, owner: Address, asset_id: u64) {
        owner.require_auth();

        let mut assets: Map<u64, IntelligenceAsset> = env
            .storage()
            .persistent()
            .get(&ASSETS)
            .unwrap_or(Map::new(&env));

        let mut asset = assets.get(asset_id).unwrap();
        assert!(asset.owner == owner, "not the asset owner");

        asset.is_active = false;
        assets.set(asset_id, asset);
        env.storage().persistent().set(&ASSETS, &assets);

        env.events().publish((symbol_short!("DELISTED"), owner), asset_id);
    }

    /// Update the price of a listed asset.
    pub fn update_price(env: Env, owner: Address, asset_id: u64, new_price: i128) {
        owner.require_auth();

        let mut assets: Map<u64, IntelligenceAsset> = env
            .storage()
            .persistent()
            .get(&ASSETS)
            .unwrap_or(Map::new(&env));

        let mut asset = assets.get(asset_id).unwrap();
        assert!(asset.owner == owner, "not the asset owner");
        assert!(asset.is_active, "asset is not active");

        asset.price = new_price;
        assets.set(asset_id, asset);
        env.storage().persistent().set(&ASSETS, &assets);
    }

    // ── Purchasing ────────────────────────────────────────────────────────

    /// Purchase a license for an intelligence asset.
    /// Payment is validated via a pre-authorized token transfer.
    pub fn purchase_license(
        env: Env,
        buyer: Address,
        asset_id: u64,
        token: Address,
    ) -> License {
        buyer.require_auth();

        let mut assets: Map<u64, IntelligenceAsset> = env
            .storage()
            .persistent()
            .get(&ASSETS)
            .unwrap_or(Map::new(&env));

        let mut asset = assets.get(asset_id).unwrap();
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
            buyer: buyer.clone(),
            license_type: asset.license.clone(),
            purchased_at: env.ledger().timestamp(),
            calls_remaining,
        };

        // Record license
        let license_key = (LISTINGS, buyer.clone(), asset_id);
        env.storage().persistent().set(&license_key, &license);

        // Increment usage counter
        asset.usage_count += 1;
        assets.set(asset_id, asset.clone());
        env.storage().persistent().set(&ASSETS, &assets);

        env.events().publish(
            (symbol_short!("PURCHASED"), buyer),
            (asset_id, asset.price),
        );

        license
    }

    // ── Queries ───────────────────────────────────────────────────────────

    /// Retrieve an asset by ID.
    pub fn get_asset(env: Env, asset_id: u64) -> Option<IntelligenceAsset> {
        let assets: Map<u64, IntelligenceAsset> = env
            .storage()
            .persistent()
            .get(&ASSETS)
            .unwrap_or(Map::new(&env));
        assets.get(asset_id)
    }

    /// Total number of assets ever listed.
    pub fn asset_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&ASSET_COUNT)
            .unwrap_or(0u64)
    }

    /// Check whether a buyer holds a valid license for an asset.
    pub fn has_license(env: Env, buyer: Address, asset_id: u64) -> bool {
        let license_key = (LISTINGS, buyer, asset_id);
        env.storage().persistent().has(&license_key)
    }

    /// Get a buyer's license details.
    pub fn get_license(env: Env, buyer: Address, asset_id: u64) -> Option<License> {
        let license_key = (LISTINGS, buyer, asset_id);
        env.storage().persistent().get(&license_key)
    }
}
