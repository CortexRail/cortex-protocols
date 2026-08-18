#![no_std]

mod errors;
pub use errors::MarketplaceError;

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, BytesN, Env, Map, String, Symbol,
    Vec,
};

/// Contract code version. Bump on every deployed upgrade so clients can
/// detect which revision is live via `version()`.
const VERSION: u32 = 1;

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
/// Maximum byte length of an asset name.
const MAX_NAME_LEN: u32 = 200;
/// Maximum byte length of an asset description.
const MAX_DESC_LEN: u32 = 2_000;

const ESCROW_HOLD_LEDGERS: u32 = 100;
const ESCROWS: Symbol = symbol_short!("ESCROWS");
const DISPUTES: Symbol = symbol_short!("DISPUTES");
const ARBITRATORS: Symbol = symbol_short!("ARBITRARS");
const LICENSE_COUNT: Symbol = symbol_short!("L_COUNT");
const DISPUTE_COUNT: Symbol = symbol_short!("D_COUNT");

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
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct License {
    pub id: u64,
    pub asset_id: u64,
    pub asset_version: u32,
    pub buyer: Address,
    pub license_type: LicenseType,
    pub purchased_at: u64,
    pub calls_remaining: u64,
}

/// Status of an escrow hold
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EscrowStatus {
    Held,
    Released,
    Disputed,
    Resolved,
}

/// Status of a purchase dispute
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DisputeStatus {
    Open,
    Resolved,
}

/// Arbitration refund outcome decision
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RefundDecision {
    None,
    FullRefund,
    /// Basis points split: 1 to 10000 (10000 = 100% refund)
    PartialRefund(u32),
    ReleaseToSeller,
}

/// Escrow hold record
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowHold {
    pub license_id: u64,
    pub buyer: Address,
    pub seller: Address,
    pub token: Address,
    pub amount: i128,
    pub created_at: u64,
    pub created_ledger: u32,
    pub hold_until_ledger: u32,
    pub status: EscrowStatus,
}

/// Purchase dispute record
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PurchaseDispute {
    pub dispute_id: u64,
    pub license_id: u64,
    pub buyer: Address,
    pub evidence_hash: BytesN<32>,
    pub created_at: u64,
    pub status: DisputeStatus,
    pub decision: RefundDecision,
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
        id: 0,
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

fn get_escrows_map(env: &Env) -> Map<u64, EscrowHold> {
    env.storage()
        .persistent()
        .get(&ESCROWS)
        .unwrap_or(Map::new(env))
}

fn set_escrow(env: &Env, license_id: u64, escrow: &EscrowHold) {
    let mut escrows = get_escrows_map(env);
    escrows.set(license_id, escrow.clone());
    env.storage().persistent().set(&ESCROWS, &escrows);
}

fn get_disputes_map(env: &Env) -> Map<u64, PurchaseDispute> {
    env.storage()
        .persistent()
        .get(&DISPUTES)
        .unwrap_or(Map::new(env))
}

fn set_dispute(env: &Env, dispute_id: u64, dispute: &PurchaseDispute) {
    let mut disputes = get_disputes_map(env);
    disputes.set(dispute_id, dispute.clone());
    env.storage().persistent().set(&DISPUTES, &disputes);
}

fn get_arbitrators_list(env: &Env) -> Vec<Address> {
    env.storage()
        .persistent()
        .get(&ARBITRATORS)
        .unwrap_or(Vec::new(env))
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
        env.storage().instance().set(&LICENSE_COUNT, &0u64);
        env.storage().instance().set(&DISPUTE_COUNT, &0u64);
    }

    /// Upgrade the contract to new WASM code. Owner-only.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        let owner: Address = env
            .storage()
            .instance()
            .get(&OWNER)
            .expect("contract not initialized");
        owner.require_auth();

        env.deployer()
            .update_current_contract_wasm(new_wasm_hash.clone());

        env.events()
            .publish((symbol_short!("UPGRADED"),), new_wasm_hash);
    }

    /// Version of the currently deployed contract code.
    pub fn version(_env: Env) -> u32 {
        VERSION
    }

    /// Current admin owner of the marketplace.
    pub fn get_owner(env: Env) -> Option<Address> {
        env.storage().instance().get(&OWNER)
    }

    // ── Asset Management ──────────────────────────────────────────────────

    ///
    /// # Errors
    /// - [`MarketplaceError::InvalidPrice`]      — `price` must be > 0.
    /// - [`MarketplaceError::InvalidMetadata`]   — `name` must be 1–200 bytes;
    ///                                             `description` must be 1–2 000 bytes.
    /// - [`MarketplaceError::AssetLimitReached`] — contract has already reached
    ///                                             `MAX_ASSETS` (10 000) listings.
    /// List a new asset. Metadata is validated against the on-chain limits:
    /// a positive price, a 1–200 byte name, and a 1–2 000 byte description.
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

        if price <= 0 {
            return Err(MarketplaceError::InvalidPrice);
        }
        if name.is_empty() || name.len() > MAX_NAME_LEN {
            return Err(MarketplaceError::InvalidMetadata);
        }
        if description.is_empty() || description.len() > MAX_DESC_LEN {
            return Err(MarketplaceError::InvalidMetadata);
        }

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

        Ok(asset_id)
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

    // ── Purchasing & Escrow ────────────────────────────────────────────────

    /// Purchase a license for an intelligence asset. Funds are held in escrow.
    pub fn purchase_license(env: Env, buyer: Address, asset_id: u64, token: Address) -> License {
        let asset = load_asset(&env, asset_id).expect("asset not found");
        let asset_version = asset.version;
        Self::purchase_license_for_version(env, buyer, asset, asset_id, asset_version, token)
    }

    /// Purchase and pin a license to a retained asset version. Funds are held in escrow.
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

        // Transfer payment from buyer into contract escrow account
        let token_client = soroban_sdk::token::Client::new(&env, &token);
        token_client.transfer(&buyer, &env.current_contract_address(), &asset.price);

        let lic_count: u64 = env.storage().instance().get(&LICENSE_COUNT).unwrap_or(0u64);
        let license_id = lic_count + 1;
        env.storage().instance().set(&LICENSE_COUNT, &license_id);

        let calls_remaining: u64 = match asset.license {
            LicenseType::UsageBased => 100,
            _ => u64::MAX,
        };

        let license = License {
            id: license_id,
            asset_id,
            asset_version,
            buyer: buyer.clone(),
            license_type: asset.license.clone(),
            purchased_at: env.ledger().timestamp(),
            calls_remaining,
        };

        let license_key = license_v2_key(buyer.clone(), asset_id);
        env.storage().persistent().set(&license_key, &license);

        // Record Escrow Hold
        let current_ledger = env.ledger().sequence();
        let hold_until_ledger = current_ledger + ESCROW_HOLD_LEDGERS;

        let escrow = EscrowHold {
            license_id,
            buyer: buyer.clone(),
            seller: asset.owner.clone(),
            token: token.clone(),
            amount: asset.price,
            created_at: env.ledger().timestamp(),
            created_ledger: current_ledger,
            hold_until_ledger,
            status: EscrowStatus::Held,
        };
        set_escrow(&env, license_id, &escrow);

        asset.usage_count += 1;
        store_v2_asset(&env, &asset);

        env.events()
            .publish((symbol_short!("PURCHASED"), buyer), (license_id, asset_id, asset.price));

        license
    }

    /// Callable by anyone after the hold period if no dispute was raised; releases funds to seller.
    pub fn release_escrow(env: Env, license_id: u64) -> Result<(), MarketplaceError> {
        let escrows = get_escrows_map(&env);
        let mut escrow = escrows
            .get(license_id)
            .ok_or(MarketplaceError::EscrowNotFound)?;

        if escrow.status == EscrowStatus::Released || escrow.status == EscrowStatus::Resolved {
            return Err(MarketplaceError::EscrowAlreadyReleased);
        }
        if escrow.status == EscrowStatus::Disputed {
            return Err(MarketplaceError::EscrowDisputed);
        }
        if env.ledger().sequence() < escrow.hold_until_ledger {
            return Err(MarketplaceError::DisputeWindowClosed);
        }

        let token_client = soroban_sdk::token::Client::new(&env, &escrow.token);
        token_client.transfer(&env.current_contract_address(), &escrow.seller, &escrow.amount);

        escrow.status = EscrowStatus::Released;
        set_escrow(&env, license_id, &escrow);

        env.events().publish(
            (Symbol::new(&env, "ESCROW_RELEASED"), escrow.seller.clone()),
            (license_id, escrow.amount),
        );

        Ok(())
    }

    // ── Dispute & Arbitration ──────────────────────────────────────────────

    /// Freezes the escrow during the hold window; callable by buyer.
    pub fn raise_purchase_dispute(
        env: Env,
        buyer: Address,
        license_id: u64,
        evidence_hash: BytesN<32>,
    ) -> Result<u64, MarketplaceError> {
        buyer.require_auth();

        let escrows = get_escrows_map(&env);
        let mut escrow = escrows
            .get(license_id)
            .ok_or(MarketplaceError::EscrowNotFound)?;

        if escrow.buyer != buyer {
            return Err(MarketplaceError::Unauthorized);
        }
        if escrow.status == EscrowStatus::Released {
            return Err(MarketplaceError::EscrowAlreadyReleased);
        }
        if escrow.status == EscrowStatus::Disputed || escrow.status == EscrowStatus::Resolved {
            return Err(MarketplaceError::EscrowDisputed);
        }
        if env.ledger().sequence() >= escrow.hold_until_ledger {
            return Err(MarketplaceError::DisputeWindowClosed);
        }

        escrow.status = EscrowStatus::Disputed;
        set_escrow(&env, license_id, &escrow);

        let dsp_count: u64 = env.storage().instance().get(&DISPUTE_COUNT).unwrap_or(0u64);
        let dispute_id = dsp_count + 1;
        env.storage().instance().set(&DISPUTE_COUNT, &dispute_id);

        let dispute = PurchaseDispute {
            dispute_id,
            license_id,
            buyer: buyer.clone(),
            evidence_hash: evidence_hash.clone(),
            created_at: env.ledger().timestamp(),
            status: DisputeStatus::Open,
            decision: RefundDecision::None,
        };
        set_dispute(&env, dispute_id, &dispute);

        env.events().publish(
            (Symbol::new(&env, "PURCHASE_DISPUTE_RAISED"), buyer.clone()),
            (dispute_id, license_id, evidence_hash),
        );

        Ok(dispute_id)
    }

    /// Owner registers an arbitrator address into the fixed arbitration committee.
    pub fn register_arbitrator(env: Env, arbitrator: Address) -> Result<(), MarketplaceError> {
        let owner: Address = env
            .storage()
            .instance()
            .get(&OWNER)
            .expect("contract not initialized");
        owner.require_auth();

        let mut arbitrators = get_arbitrators_list(&env);
        if !arbitrators.contains(&arbitrator) {
            arbitrators.push_back(arbitrator);
            env.storage().persistent().set(&ARBITRATORS, &arbitrators);
        }

        Ok(())
    }

    /// Resolves a purchase dispute based on majority vote of the arbitrator committee.
    pub fn resolve_purchase_dispute(
        env: Env,
        dispute_id: u64,
        arbitrator_votes: Vec<(Address, RefundDecision)>,
    ) -> Result<(), MarketplaceError> {
        let disputes = get_disputes_map(&env);
        let mut dispute = disputes
            .get(dispute_id)
            .ok_or(MarketplaceError::DisputeNotFound)?;

        if dispute.status != DisputeStatus::Open {
            return Err(MarketplaceError::DisputeAlreadyResolved);
        }
        if arbitrator_votes.is_empty() {
            return Err(MarketplaceError::NoArbitratorVotes);
        }

        let arbitrators = get_arbitrators_list(&env);

        for vote in arbitrator_votes.iter() {
            let (voter, _) = vote;
            if !arbitrators.contains(&voter) {
                return Err(MarketplaceError::NotArbitrator);
            }
        }

        let mut full_refund_votes: u32 = 0;
        let mut release_votes: u32 = 0;
        let mut partial_refund_votes: u32 = 0;
        let mut sum_partial_bps: u64 = 0;

        for vote in arbitrator_votes.iter() {
            let (_, decision) = vote;
            match decision {
                RefundDecision::FullRefund => full_refund_votes += 1,
                RefundDecision::ReleaseToSeller => release_votes += 1,
                RefundDecision::PartialRefund(bps) => {
                    if bps > 10000 {
                        return Err(MarketplaceError::InvalidRefundBps);
                    }
                    partial_refund_votes += 1;
                    sum_partial_bps += bps as u64;
                }
                RefundDecision::None => {}
            }
        }

        let winning_decision = if full_refund_votes > release_votes
            && full_refund_votes >= partial_refund_votes
        {
            RefundDecision::FullRefund
        } else if release_votes > full_refund_votes && release_votes >= partial_refund_votes {
            RefundDecision::ReleaseToSeller
        } else if partial_refund_votes > 0 {
            let avg_bps = (sum_partial_bps / partial_refund_votes as u64) as u32;
            RefundDecision::PartialRefund(avg_bps)
        } else {
            RefundDecision::PartialRefund(5000)
        };

        let escrows = get_escrows_map(&env);
        let mut escrow = escrows
            .get(dispute.license_id)
            .ok_or(MarketplaceError::EscrowNotFound)?;

        let token_client = soroban_sdk::token::Client::new(&env, &escrow.token);
        let contract_addr = env.current_contract_address();

        match winning_decision {
            RefundDecision::FullRefund => {
                token_client.transfer(&contract_addr, &escrow.buyer, &escrow.amount);
            }
            RefundDecision::ReleaseToSeller => {
                token_client.transfer(&contract_addr, &escrow.seller, &escrow.amount);
            }
            RefundDecision::PartialRefund(bps) => {
                if bps > 10000 {
                    return Err(MarketplaceError::InvalidRefundBps);
                }
                let refund_amount = (escrow.amount * (bps as i128)) / 10000;
                let seller_amount = escrow.amount - refund_amount;
                if refund_amount > 0 {
                    token_client.transfer(&contract_addr, &escrow.buyer, &refund_amount);
                }
                if seller_amount > 0 {
                    token_client.transfer(&contract_addr, &escrow.seller, &seller_amount);
                }
            }
            RefundDecision::None => {}
        }

        escrow.status = EscrowStatus::Resolved;
        set_escrow(&env, dispute.license_id, &escrow);

        dispute.status = DisputeStatus::Resolved;
        dispute.decision = winning_decision.clone();
        set_dispute(&env, dispute_id, &dispute);

        let decision_val = match winning_decision {
            RefundDecision::FullRefund => 1u32,
            RefundDecision::PartialRefund(bps) => 20000u32 + bps,
            RefundDecision::ReleaseToSeller => 3u32,
            RefundDecision::None => 0u32,
        };

        env.events().publish(
            (Symbol::new(&env, "PURCHASE_DISPUTE_RESOLVED"), escrow.buyer.clone()),
            (dispute_id, dispute.license_id, decision_val),
        );

        Ok(())
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

    /// Retrieve an escrow hold by license ID.
    pub fn get_escrow(env: Env, license_id: u64) -> Option<EscrowHold> {
        get_escrows_map(&env).get(license_id)
    }

    /// Retrieve a dispute by dispute ID.
    pub fn get_dispute(env: Env, dispute_id: u64) -> Option<PurchaseDispute> {
        get_disputes_map(&env).get(dispute_id)
    }

    /// Retrieve the list of registered arbitrators.
    pub fn get_arbitrators(env: Env) -> Vec<Address> {
        get_arbitrators_list(&env)
    }

    /// Check if an address is a registered arbitrator.
    pub fn is_arbitrator(env: Env, address: Address) -> bool {
        get_arbitrators_list(&env).contains(&address)
    }
}

