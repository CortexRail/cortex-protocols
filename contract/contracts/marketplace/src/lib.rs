#![no_std]

extern crate alloc;

mod errors;
pub use errors::MarketplaceError;

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Bytes, BytesN, Env, Map, String,
    Symbol, Vec,
};

/// Contract code version. Bump on every deployed upgrade so clients can
/// detect which revision is live via `version()`.
const VERSION: u32 = 2;

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

const AUCTIONS: Symbol = symbol_short!("AUCTIONS");
const AUCTION_COUNT: Symbol = symbol_short!("AUCT_CNT");
const COMMITMENTS: Symbol = symbol_short!("COMMITS");
const BIDS: Symbol = symbol_short!("BIDS");

/// Hard cap on concurrently listed assets.
const MAX_ASSETS: u64 = 10_000;

/// Longest allowed listing name, in bytes.
const MAX_NAME_LEN: u32 = 200;
/// Longest allowed listing description, in bytes.
const MAX_DESC_LEN: u32 = 2_000;

/// Any reveal landing in the final `SNIPING_WINDOW` ledgers of the reveal
/// window extends the window by `SNIPING_WINDOW` more ledgers (anti-sniping).
const SNIPING_WINDOW: u32 = 5;

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

/// Lifecycle phase of a sealed-bid auction.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AuctionPhase {
    /// Commit window open; only bid commitments (hashes) are accepted.
    Commit,
    /// Reveal window open; committed bidders reveal and escrow amounts.
    Reveal,
    /// Settlement completed; winners admitted and payouts executed.
    Settled,
}

/// A sealed-bid, second-price auction for a capacity-constrained asset.
#[contracttype]
#[derive(Clone, Debug)]
pub struct Auction {
    pub id: u64,
    pub seller: Address,
    pub asset_id: u64,
    /// Number of concurrent capacity slots awarded to the top bidders.
    pub capacity: u32,
    /// Reserve price; reveals below this are rejected and losers pay nothing.
    pub min_bid: i128,
    /// Length of the commit window (ledgers). The reveal window is the same
    /// length, starting when the commit window closes.
    pub duration_ledgers: u32,
    pub open_ledger: u32,
    /// Ledger at which the reveal window closes (0 until reveal begins).
    pub reveal_end: u32,
    pub phase: AuctionPhase,
    /// Escrow token, locked on the first reveal and enforced for all reveals.
    pub token: Option<Address>,
    /// Bidders that revealed, in reveal order. Ties are broken by this order.
    pub revealed: Vec<Address>,
    /// Uniform second price paid by every admitted bidder (set at settlement).
    pub clearing_price: Option<i128>,
    pub settled_at: Option<u32>,
}

/// A revealed bid locked into the auction escrow.
#[contracttype]
#[derive(Clone, Debug)]
pub struct Bid {
    pub amount: i128,
    pub token: Address,
    pub revealed_at: u32,
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

fn auction_key(auction_id: u64) -> (Symbol, u64) {
    (AUCTIONS, auction_id)
}

fn commitment_key(auction_id: u64, bidder: &Address) -> (Symbol, u64, Address) {
    (COMMITMENTS, auction_id, bidder.clone())
}

fn bid_key(auction_id: u64, bidder: &Address) -> (Symbol, u64, Address) {
    (BIDS, auction_id, bidder.clone())
}

fn load_auction(env: &Env, auction_id: u64) -> Result<Auction, MarketplaceError> {
    env.storage()
        .persistent()
        .get(&auction_key(auction_id))
        .ok_or(MarketplaceError::AuctionNotFound)
}

/// Canonical commitment preimage: big-endian `amount` bytes followed by the
/// 32-byte salt. Both client-side builders (SDK, contract tests) and the
/// contract derive the same hash from this layout.
fn commitment_preimage(env: &Env, amount: i128, salt: &BytesN<32>) -> Bytes {
    let mut input = Bytes::new(env);
    input.append(&Bytes::from_slice(env, &amount.to_be_bytes()));
    input.append(&Bytes::from_slice(env, &salt.to_array()));
    input
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

    /// Upgrade the contract to new WASM code. Owner-only.
    ///
    /// `new_wasm_hash` must reference WASM already uploaded to the network
    /// (`stellar contract upload`). Storage is preserved across upgrades;
    /// the new code serves every invocation after this transaction.
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

        if price <= 0 {
            return Err(MarketplaceError::InvalidPrice);
        }
        if name.len() == 0 || name.len() > MAX_NAME_LEN {
            return Err(MarketplaceError::InvalidMetadata);
        }
        if description.len() == 0 || description.len() > MAX_DESC_LEN {
            return Err(MarketplaceError::InvalidMetadata);
        }

        let count: u64 = env.storage().instance().get(&ASSET_COUNT).unwrap_or(0u64);
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

    // ── Sealed-Bid Auctions ──────────────────────────────────────────────
    //
    // Commitment scheme: bidders commit `sha256(amount_be_bytes || salt)`
    // during the commit window, then reveal `(amount, salt)` during the
    // reveal window. No bid amount is observable before its reveal.
    // Settlement admits the top `capacity` revealed bids, each paying the
    // uniform second price (the `capacity + 1`-th bid, or the reserve when
    // fewer bids than capacity are revealed); losers are fully refunded.

    /// Open a sealed-bid auction for a capacity-constrained asset.
    ///
    /// Only the asset owner may open an auction. The contract escrows no
    /// funds here; escrow is funded per-reveal. The commit window lasts
    /// `duration_ledgers`; `begin_reveal` then opens an equally long reveal
    /// window, after which `settle_auction` admits the winners.
    pub fn open_auction(
        env: Env,
        seller: Address,
        asset_id: u64,
        capacity: u32,
        min_bid: i128,
        duration_ledgers: u32,
    ) -> Result<u64, MarketplaceError> {
        seller.require_auth();

        if capacity == 0 || duration_ledgers == 0 {
            return Err(MarketplaceError::InvalidAuctionParams);
        }
        if min_bid <= 0 {
            return Err(MarketplaceError::InvalidBidAmount);
        }

        let asset = load_asset(&env, asset_id).ok_or(MarketplaceError::AssetNotFound)?;
        if !asset.is_active {
            return Err(MarketplaceError::AssetInactive);
        }
        if asset.owner != seller {
            return Err(MarketplaceError::NotOwner);
        }

        let count: u64 = env.storage().instance().get(&AUCTION_COUNT).unwrap_or(0u64);
        let auction_id = count + 1;

        let auction = Auction {
            id: auction_id,
            seller: seller.clone(),
            asset_id,
            capacity,
            min_bid,
            duration_ledgers,
            open_ledger: env.ledger().sequence(),
            reveal_end: 0,
            phase: AuctionPhase::Commit,
            token: None,
            revealed: Vec::new(&env),
            clearing_price: None,
            settled_at: None,
        };
        env.storage().persistent().set(&auction_key(auction_id), &auction);
        env.storage().instance().set(&AUCTION_COUNT, &auction_id);

        env.events().publish(
            (symbol_short!("AUCT_OPEN"), seller),
            (auction_id, asset_id, capacity, min_bid, duration_ledgers),
        );

        Ok(auction_id)
    }

    /// Transition an auction from the commit window to the reveal window.
    ///
    /// Callable by anyone once `duration_ledgers` have elapsed since open.
    /// Returns the reveal window's closing ledger. The backend auction
    /// engine calls this automatically when it observes the commit window
    /// end on-chain.
    pub fn begin_reveal(env: Env, auction_id: u64) -> Result<u32, MarketplaceError> {
        let mut auction = load_auction(&env, auction_id)?;
        if auction.phase != AuctionPhase::Commit {
            return Err(MarketplaceError::AuctionPhaseError);
        }
        let now = env.ledger().sequence();
        let commit_end = auction
            .open_ledger
            .checked_add(auction.duration_ledgers)
            .expect("ledger overflow");
        if now < commit_end {
            return Err(MarketplaceError::AuctionPhaseError);
        }

        auction.phase = AuctionPhase::Reveal;
        auction.reveal_end = now
            .checked_add(auction.duration_ledgers)
            .expect("ledger overflow");
        env.storage().persistent().set(&auction_key(auction_id), &auction);

        env.events().publish(
            (symbol_short!("REVEAL_OP"),),
            (auction_id, auction.reveal_end),
        );

        Ok(auction.reveal_end)
    }

    /// Commit to a hidden bid during the commit window.
    ///
    /// Only the hash is stored; the amount cannot be derived from it.
    /// A bidder may commit at most once and may reveal only the exact
    /// amount/salt pair that produced this hash.
    pub fn commit_bid(
        env: Env,
        bidder: Address,
        auction_id: u64,
        bid_hash: BytesN<32>,
    ) -> Result<(), MarketplaceError> {
        bidder.require_auth();

        let auction = load_auction(&env, auction_id)?;
        if auction.phase != AuctionPhase::Commit {
            return Err(MarketplaceError::AuctionPhaseError);
        }

        env.storage()
            .persistent()
            .set(&commitment_key(auction_id, &bidder), &bid_hash);

        env.events()
            .publish((symbol_short!("COMMITTED"), bidder), auction_id);

        Ok(())
    }

    /// Reveal a committed bid and lock the amount into the auction escrow.
    ///
    /// Validates the revealed `(amount, salt)` reproduces the committed
    /// hash, rejects bids below the reserve, and transfers `amount` of the
    /// auction token from the bidder to the contract. Reveals landing in
    /// the final `SNIPING_WINDOW` ledgers extend the window by
    /// `SNIPING_WINDOW` more ledgers (anti-sniping). Returns the (possibly
    /// extended) reveal closing ledger.
    pub fn reveal_bid(
        env: Env,
        bidder: Address,
        auction_id: u64,
        amount: i128,
        salt: BytesN<32>,
        token: Address,
    ) -> Result<u32, MarketplaceError> {
        bidder.require_auth();

        let mut auction = load_auction(&env, auction_id)?;
        if auction.phase != AuctionPhase::Reveal {
            return Err(MarketplaceError::AuctionPhaseError);
        }
        let now = env.ledger().sequence();
        if now >= auction.reveal_end {
            return Err(MarketplaceError::AuctionPhaseError);
        }

        let key = commitment_key(auction_id, &bidder);
        let committed = env
            .storage()
            .persistent()
            .get::<_, BytesN<32>>(&key)
            .ok_or(MarketplaceError::BidNotCommitted)?;
        let expected = env.crypto().sha256(&commitment_preimage(&env, amount, &salt));
        if expected.to_bytes() != committed {
            return Err(MarketplaceError::CommitmentMismatch);
        }

        if amount < auction.min_bid {
            return Err(MarketplaceError::InvalidBidAmount);
        }

        // A single escrow token per auction keeps the uniform clearing price
        // meaningful. The first reveal fixes it; later ones must match.
        if let Some(auction_token) = &auction.token {
            if *auction_token != token {
                return Err(MarketplaceError::TokenMismatch);
            }
        } else {
            auction.token = Some(token.clone());
        }

        // One reveal per bidder; guard before any funds move.
        if env.storage().persistent().has(&bid_key(auction_id, &bidder)) {
            return Err(MarketplaceError::BidAlreadyRevealed);
        }

        // Lock the bid amount into the auction escrow (contract holds it).
        let token_client = soroban_sdk::token::Client::new(&env, &token);
        token_client.transfer(&bidder, &env.current_contract_address(), &amount);

        let mut extended = false;
        if now >= auction.reveal_end.saturating_sub(SNIPING_WINDOW) {
            auction.reveal_end = auction
                .reveal_end
                .checked_add(SNIPING_WINDOW)
                .expect("ledger overflow");
            extended = true;
        }

        let bid = Bid {
            amount,
            token: token.clone(),
            revealed_at: now,
        };
        env.storage()
            .persistent()
            .set(&bid_key(auction_id, &bidder), &bid);
        auction.revealed.push_back(bidder.clone());
        env.storage().persistent().set(&auction_key(auction_id), &auction);

        if extended {
            env.events().publish(
                (symbol_short!("EXTENDED"), bidder.clone()),
                (auction_id, auction.reveal_end),
            );
        }
        env.events().publish(
            (symbol_short!("REVEALED"), bidder),
            (auction_id, amount, auction.reveal_end),
        );

        Ok(auction.reveal_end)
    }

    /// Settle an auction once the reveal window has closed.
    ///
    /// Ranks revealed bids highest-first (ties broken by reveal order),
    /// admits the top `capacity` as winners, each paying the uniform
    /// second price — the `capacity + 1`-th bid when more than `capacity`
    /// bids were revealed, otherwise the reserve price. Winners receive
    /// their excess back, losers are fully refunded, and the seller
    /// receives `winners * clearing_price` from escrow. Returns the
    /// admitted winners in rank order.
    pub fn settle_auction(env: Env, auction_id: u64) -> Result<Vec<Address>, MarketplaceError> {
        let mut auction = load_auction(&env, auction_id)?;
        if auction.phase != AuctionPhase::Reveal {
            return Err(MarketplaceError::AuctionPhaseError);
        }
        let now = env.ledger().sequence();
        if now < auction.reveal_end {
            return Err(MarketplaceError::AuctionPhaseError);
        }

        let mut ranked: alloc::vec::Vec<(Address, i128)> = auction
            .revealed
            .iter()
            .map(|bidder| {
                let bid: Bid = env
                    .storage()
                    .persistent()
                    .get(&bid_key(auction_id, &bidder))
                    .expect("revealed bidder missing bid");
                (bidder, bid.amount)
            })
            .collect();

        // Stable sort: descending amount; ties keep reveal order.
        ranked.sort_by(|left, right| right.1.cmp(&left.1));

        let n = ranked.len();
        let capacity = auction.capacity as usize;
        let clearing_price: i128 = if n > capacity {
            ranked[capacity].1
        } else {
            auction.min_bid
        };

        let mut winners: Vec<Address> = Vec::new(&env);
        for (bidder, _) in ranked.iter().take(capacity) {
            winners.push_back(bidder.clone());
        }

        let contract = env.current_contract_address();
        if let Some(token) = &auction.token {
            let token_client = soroban_sdk::token::Client::new(&env, token);
            for (bidder, amount) in &ranked {
                let is_winner = winners.contains(bidder);
                if is_winner && *amount > clearing_price {
                    token_client.transfer(
                        &contract,
                        bidder,
                        &(*amount - clearing_price),
                    );
                } else if !is_winner {
                    token_client.transfer(&contract, bidder, amount);
                }
            }
            if !winners.is_empty() {
                let seller_payment = clearing_price
                    .checked_mul(winners.len() as i128)
                    .expect("payment overflow");
                token_client.transfer(&contract, &auction.seller, &seller_payment);
            }
        }

        auction.phase = AuctionPhase::Settled;
        auction.clearing_price = Some(clearing_price);
        auction.settled_at = Some(now);
        env.storage().persistent().set(&auction_key(auction_id), &auction);

        env.events().publish(
            (symbol_short!("AUCT_SETL"),),
            (auction_id, winners.clone(), clearing_price),
        );

        Ok(winners)
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

    /// Retrieve an auction by ID.
    pub fn get_auction(env: Env, auction_id: u64) -> Option<Auction> {
        env.storage().persistent().get(&auction_key(auction_id))
    }

    /// Retrieve a revealed bid by auction and bidder.
    pub fn get_bid(env: Env, auction_id: u64, bidder: Address) -> Option<Bid> {
        env.storage()
            .persistent()
            .get(&bid_key(auction_id, &bidder))
    }
}
