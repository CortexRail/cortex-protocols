//! Pure-Rust reference model for differential fuzzing of Cortex protocol
//! marketplace and micropayments semantics.
//!
//! This module provides a non-Soroban, deterministic, in-memory reference
//! implementation (`State`) used to verify on-chain contracts and cross-check
//! state transitions during differential fuzzing campaigns.

#![allow(dead_code, unused_imports)]

use std::collections::BTreeMap;

/// Maximum number of concurrently listed assets permitted.
pub const MAX_ASSETS: u64 = 10_000;
/// Maximum length in bytes for asset names.
pub const MAX_NAME_LEN: usize = 200;
/// Maximum length in bytes for asset descriptions.
pub const MAX_DESC_LEN: usize = 2_000;
/// Maximum number of tags allowed per asset.
pub const MAX_TAGS: usize = 10;
/// Maximum length in bytes for an individual tag.
pub const MAX_TAG_LEN: usize = 30;
/// Retained history window size for versioned asset descriptions.
pub const HISTORY_LIMIT: usize = 5;
/// Default initial calls granted for a usage-based license.
pub const DEFAULT_USAGE_BASED_CALLS: u64 = 100;
/// Default starting reputation score in basis points (50.00%).
pub const DEFAULT_REPUTATION: u32 = 5_000;
/// Escrow hold duration in ledgers.
pub const ESCROW_HOLD_LEDGERS: u32 = 100;

/// Identifier representation for an account address.
pub type AccountId = String;
/// Identifier representation for a token contract or asset symbol.
pub type TokenId = String;

/// Categories of intelligence assets that can be traded.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, arbitrary::Arbitrary)]
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

/// Licensing model for an intelligence asset.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, arbitrary::Arbitrary)]
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

/// Lifecycle status of a payment stream.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, arbitrary::Arbitrary)]
pub enum StreamStatus {
    Active,
    Paused,
    Completed,
    Cancelled,
}

/// Status of an escrow hold.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, arbitrary::Arbitrary)]
pub enum EscrowStatus {
    Held,
    Released,
    Disputed,
    Resolved,
}

/// Description snapshot retained for a published asset version.
#[derive(Clone, Debug, PartialEq, Eq, arbitrary::Arbitrary)]
pub struct AssetVersion {
    pub version: u32,
    pub description: String,
    pub updated_at: u64,
}

/// Core intelligence asset record in the reference model.
#[derive(Clone, Debug, PartialEq, Eq, arbitrary::Arbitrary)]
pub struct Asset {
    pub id: u64,
    pub owner: AccountId,
    pub name: String,
    pub description: String,
    pub asset_type: AssetType,
    pub license_type: LicenseType,
    /// Price in stroops (1 XLM = 10_000_000 stroops).
    pub price: i128,
    /// Reputation score in basis points (0–10_000).
    pub reputation: u32,
    pub usage_count: u64,
    pub is_active: bool,
    pub created_at: u64,
    pub version: u32,
    pub tags: Vec<String>,
}

/// License grant / purchase record.
#[derive(Clone, Debug, PartialEq, Eq, arbitrary::Arbitrary)]
pub struct License {
    pub id: u64,
    pub asset_id: u64,
    pub asset_version: u32,
    pub buyer: AccountId,
    pub license_type: LicenseType,
    pub purchased_at: u64,
    pub calls_remaining: u64,
    pub expires_at: u64,
    pub renewal_count: u32,
    pub grace_period_end: u64,
    pub auto_renew: bool,
}

/// Payment stream tracking deposits, withdrawals, and locked amounts.
#[derive(Clone, Debug, PartialEq, Eq, arbitrary::Arbitrary)]
pub struct Stream {
    pub id: u64,
    pub sender: AccountId,
    pub recipient: AccountId,
    pub token: TokenId,
    pub deposit: i128,
    pub locked_amount: i128,
    pub rate_per_second: i128,
    pub start_time: u64,
    pub end_time: u64,
    pub last_settled: u64,
    pub withdrawn: i128,
    pub status: StreamStatus,
}

impl Stream {
    /// Compute claimable / accrued amount at a given timestamp.
    pub fn claimable(&self, now: u64) -> i128 {
        if self.status != StreamStatus::Active {
            return 0;
        }
        let elapsed = now.saturating_sub(self.last_settled) as i128;
        let earned = elapsed.saturating_mul(self.rate_per_second);
        let remaining = self.deposit.saturating_sub(self.withdrawn);
        if earned > remaining {
            remaining
        } else {
            earned
        }
    }
}

/// Purchase escrow hold record.
#[derive(Clone, Debug, PartialEq, Eq, arbitrary::Arbitrary)]
pub struct EscrowHold {
    pub license_id: u64,
    pub buyer: AccountId,
    pub seller: AccountId,
    pub token: TokenId,
    pub amount: i128,
    pub created_at: u64,
    pub created_ledger: u32,
    pub hold_until_ledger: u32,
    pub status: EscrowStatus,
}

/// Error type capturing failure conditions in the reference model.
#[derive(Clone, Debug, PartialEq, Eq, arbitrary::Arbitrary)]
pub enum ModelError {
    InsufficientBalance {
        account: AccountId,
        token: TokenId,
        required: i128,
        available: i128,
    },
    AssetNotFound(u64),
    AssetInactive(u64),
    NotAssetOwner {
        asset_id: u64,
        caller: AccountId,
        owner: AccountId,
    },
    SelfPurchase,
    InvalidPrice(i128),
    InvalidMetadata(String),
    AssetLimitReached(u64),
    LicenseNotFound,
    LicenseAlreadyExists,
    Unauthorized,
    StreamNotFound(u64),
    StreamNotActive(u64),
    NotStreamSender {
        stream_id: u64,
        caller: AccountId,
    },
    NotStreamRecipient {
        stream_id: u64,
        caller: AccountId,
    },
    InvalidAmount(i128),
    InvalidDuration(u64),
    NoCallsRemaining,
    ArithmeticOverflow,
    EscrowNotFound(u64),
    EscrowAlreadyReleased(u64),
}

/// In-memory pure-Rust reference state for the marketplace and micropayments.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct State {
    /// Account balances: `(account_id, token_id)` -> balance.
    pub balances: BTreeMap<(AccountId, TokenId), i128>,
    /// Active and completed streams: `stream_id` -> Stream.
    pub streams: BTreeMap<u64, Stream>,
    /// Counter for assigning next stream ID.
    pub next_stream_id: u64,
    /// Assets catalog: `asset_id` -> Asset.
    pub assets: BTreeMap<u64, Asset>,
    /// Retained version histories: `asset_id` -> Vec<AssetVersion>.
    pub asset_history: BTreeMap<u64, Vec<AssetVersion>>,
    /// Counter for assigning next asset ID.
    pub next_asset_id: u64,
    /// Granted licenses: `license_id` -> License.
    pub licenses: BTreeMap<u64, License>,
    /// Fast license lookup index: `(buyer, asset_id)` -> `license_id`.
    pub buyer_licenses: BTreeMap<(AccountId, u64), u64>,
    /// Counter for assigning next license ID.
    pub next_license_id: u64,
    /// Purchase escrow holds: `license_id` -> EscrowHold.
    pub escrows: BTreeMap<u64, EscrowHold>,
    /// Simulated current ledger timestamp in seconds.
    pub timestamp: u64,
    /// Simulated current ledger sequence number.
    pub ledger_sequence: u32,
}

impl State {
    /// Create a new, empty reference state starting with ID counters at 1.
    pub fn new() -> Self {
        Self {
            balances: BTreeMap::new(),
            streams: BTreeMap::new(),
            next_stream_id: 1,
            assets: BTreeMap::new(),
            asset_history: BTreeMap::new(),
            next_asset_id: 1,
            licenses: BTreeMap::new(),
            buyer_licenses: BTreeMap::new(),
            next_license_id: 1,
            escrows: BTreeMap::new(),
            timestamp: 0,
            ledger_sequence: 1,
        }
    }

    // ── Balance Operations ───────────────────────────────────────────────────

    /// Retrieve the balance for a given account and token.
    pub fn get_balance(&self, account: &AccountId, token: &TokenId) -> i128 {
        self.balances
            .get(&(account.clone(), token.clone()))
            .copied()
            .unwrap_or(0)
    }

    /// Set an account's token balance.
    pub fn set_balance(&mut self, account: AccountId, token: TokenId, amount: i128) {
        self.balances.insert((account, token), amount);
    }

    /// Mint or credit tokens to an account.
    pub fn mint(&mut self, account: AccountId, token: TokenId, amount: i128) {
        let current = self.get_balance(&account, &token);
        self.set_balance(account, token, current.saturating_add(amount));
    }

    /// Transfer tokens between accounts within the reference model.
    pub fn transfer_tokens(
        &mut self,
        from: &AccountId,
        to: &AccountId,
        token: &TokenId,
        amount: i128,
    ) -> Result<(), ModelError> {
        if amount < 0 {
            return Err(ModelError::InvalidAmount(amount));
        }
        if amount == 0 {
            return Ok(());
        }
        let from_balance = self.get_balance(from, token);
        if from_balance < amount {
            return Err(ModelError::InsufficientBalance {
                account: from.clone(),
                token: token.clone(),
                required: amount,
                available: from_balance,
            });
        }
        let to_balance = self.get_balance(to, token);
        self.set_balance(from.clone(), token.clone(), from_balance - amount);
        self.set_balance(to.clone(), token.clone(), to_balance.saturating_add(amount));
        Ok(())
    }

    // ── Asset Lifecycle ──────────────────────────────────────────────────────

    /// List a new intelligence asset in the marketplace.
    ///
    /// Validates price, metadata lengths, tag counts, and asset capacity limits.
    pub fn list_asset(
        &mut self,
        owner: AccountId,
        name: String,
        description: String,
        asset_type: AssetType,
        license_type: LicenseType,
        price: i128,
        tags: Vec<String>,
    ) -> Result<u64, ModelError> {
        if price <= 0 {
            return Err(ModelError::InvalidPrice(price));
        }
        if name.is_empty() || name.len() > MAX_NAME_LEN {
            return Err(ModelError::InvalidMetadata(format!(
                "name length must be between 1 and {}",
                MAX_NAME_LEN
            )));
        }
        if description.is_empty() || description.len() > MAX_DESC_LEN {
            return Err(ModelError::InvalidMetadata(format!(
                "description length must be between 1 and {}",
                MAX_DESC_LEN
            )));
        }
        if tags.len() > MAX_TAGS {
            return Err(ModelError::InvalidMetadata(format!(
                "tags count must not exceed {}",
                MAX_TAGS
            )));
        }
        for tag in &tags {
            if tag.is_empty() || tag.len() > MAX_TAG_LEN {
                return Err(ModelError::InvalidMetadata(format!(
                    "tag length must be between 1 and {}",
                    MAX_TAG_LEN
                )));
            }
        }
        if self.assets.len() as u64 >= MAX_ASSETS {
            return Err(ModelError::AssetLimitReached(MAX_ASSETS));
        }

        let asset_id = self.next_asset_id;
        self.next_asset_id = self
            .next_asset_id
            .checked_add(1)
            .ok_or(ModelError::ArithmeticOverflow)?;

        let asset = Asset {
            id: asset_id,
            owner,
            name,
            description: description.clone(),
            asset_type,
            license_type,
            price,
            reputation: DEFAULT_REPUTATION,
            usage_count: 0,
            is_active: true,
            created_at: self.timestamp,
            version: 1,
            tags,
        };

        self.assets.insert(asset_id, asset);
        self.asset_history.insert(
            asset_id,
            vec![AssetVersion {
                version: 1,
                description,
                updated_at: self.timestamp,
            }],
        );

        Ok(asset_id)
    }

    /// Transfer ownership of an intelligence asset to a new owner.
    pub fn transfer_asset(
        &mut self,
        current_owner: AccountId,
        new_owner: AccountId,
        asset_id: u64,
    ) -> Result<(), ModelError> {
        let asset = self
            .assets
            .get_mut(&asset_id)
            .ok_or(ModelError::AssetNotFound(asset_id))?;

        if asset.owner != current_owner {
            return Err(ModelError::NotAssetOwner {
                asset_id,
                caller: current_owner,
                owner: asset.owner.clone(),
            });
        }
        if !asset.is_active {
            return Err(ModelError::AssetInactive(asset_id));
        }
        if new_owner.is_empty() {
            return Err(ModelError::InvalidMetadata(
                "new owner address cannot be empty".into(),
            ));
        }

        asset.owner = new_owner;
        Ok(())
    }

    /// Publish a new description and increment the asset's version.
    pub fn publish_update(
        &mut self,
        owner: AccountId,
        asset_id: u64,
        new_description: String,
    ) -> Result<(), ModelError> {
        let asset = self
            .assets
            .get_mut(&asset_id)
            .ok_or(ModelError::AssetNotFound(asset_id))?;

        if asset.owner != owner {
            return Err(ModelError::NotAssetOwner {
                asset_id,
                caller: owner,
                owner: asset.owner.clone(),
            });
        }
        if !asset.is_active {
            return Err(ModelError::AssetInactive(asset_id));
        }
        if new_description.is_empty() || new_description.len() > MAX_DESC_LEN {
            return Err(ModelError::InvalidMetadata(format!(
                "description length must be between 1 and {}",
                MAX_DESC_LEN
            )));
        }

        let new_version = asset
            .version
            .checked_add(1)
            .ok_or(ModelError::ArithmeticOverflow)?;
        asset.version = new_version;
        asset.description = new_description.clone();

        let history = self.asset_history.entry(asset_id).or_default();
        history.push(AssetVersion {
            version: new_version,
            description: new_description,
            updated_at: self.timestamp,
        });
        while history.len() > HISTORY_LIMIT {
            history.remove(0);
        }

        Ok(())
    }

    /// Delist or deactivate an asset. Only the owner can delist.
    pub fn delist_asset(&mut self, owner: AccountId, asset_id: u64) -> Result<(), ModelError> {
        let asset = self
            .assets
            .get_mut(&asset_id)
            .ok_or(ModelError::AssetNotFound(asset_id))?;

        if asset.owner != owner {
            return Err(ModelError::NotAssetOwner {
                asset_id,
                caller: owner,
                owner: asset.owner.clone(),
            });
        }
        asset.is_active = false;
        Ok(())
    }

    /// Update the listed price of an active asset.
    pub fn update_price(
        &mut self,
        owner: AccountId,
        asset_id: u64,
        new_price: i128,
    ) -> Result<(), ModelError> {
        if new_price <= 0 {
            return Err(ModelError::InvalidPrice(new_price));
        }
        let asset = self
            .assets
            .get_mut(&asset_id)
            .ok_or(ModelError::AssetNotFound(asset_id))?;

        if asset.owner != owner {
            return Err(ModelError::NotAssetOwner {
                asset_id,
                caller: owner,
                owner: asset.owner.clone(),
            });
        }
        if !asset.is_active {
            return Err(ModelError::AssetInactive(asset_id));
        }

        asset.price = new_price;
        Ok(())
    }

    // ── Licensing & Purchases ────────────────────────────────────────────────

    /// Purchase a license for an active intelligence asset.
    pub fn purchase_license(
        &mut self,
        buyer: AccountId,
        asset_id: u64,
        token: TokenId,
    ) -> Result<License, ModelError> {
        let asset_version = {
            let asset = self
                .assets
                .get(&asset_id)
                .ok_or(ModelError::AssetNotFound(asset_id))?;
            asset.version
        };
        self.purchase_license_for_version(buyer, asset_id, asset_version, token)
    }

    /// Purchase and pin a license to a specific retained version.
    pub fn purchase_license_version(
        &mut self,
        buyer: AccountId,
        asset_id: u64,
        asset_version: u32,
        token: TokenId,
    ) -> Result<License, ModelError> {
        if asset_version == 0 {
            return Err(ModelError::InvalidMetadata("version must be > 0".into()));
        }
        let current_version = {
            let asset = self
                .assets
                .get(&asset_id)
                .ok_or(ModelError::AssetNotFound(asset_id))?;
            asset.version
        };
        if asset_version > current_version {
            return Err(ModelError::InvalidMetadata(
                "requested version is in the future".into(),
            ));
        }
        let retained = self
            .asset_history
            .get(&asset_id)
            .map(|history| history.iter().any(|v| v.version == asset_version))
            .unwrap_or(false);
        if !retained {
            return Err(ModelError::InvalidMetadata(
                "requested version is no longer retained in history".into(),
            ));
        }
        self.purchase_license_for_version(buyer, asset_id, asset_version, token)
    }

    fn purchase_license_for_version(
        &mut self,
        buyer: AccountId,
        asset_id: u64,
        asset_version: u32,
        token: TokenId,
    ) -> Result<License, ModelError> {
        let (price, seller, license_type, is_active) = {
            let asset = self
                .assets
                .get(&asset_id)
                .ok_or(ModelError::AssetNotFound(asset_id))?;
            (
                asset.price,
                asset.owner.clone(),
                asset.license_type.clone(),
                asset.is_active,
            )
        };

        if !is_active {
            return Err(ModelError::AssetInactive(asset_id));
        }
        if buyer == seller {
            return Err(ModelError::SelfPurchase);
        }

        // Deduct payment from buyer
        let buyer_bal = self.get_balance(&buyer, &token);
        if buyer_bal < price {
            return Err(ModelError::InsufficientBalance {
                account: buyer,
                token,
                required: price,
                available: buyer_bal,
            });
        }
        self.set_balance(buyer.clone(), token.clone(), buyer_bal - price);

        let license_id = self.next_license_id;
        self.next_license_id = self
            .next_license_id
            .checked_add(1)
            .ok_or(ModelError::ArithmeticOverflow)?;

        let calls_remaining = match license_type {
            LicenseType::UsageBased => DEFAULT_USAGE_BASED_CALLS,
            _ => u64::MAX,
        };

        let license = License {
            id: license_id,
            asset_id,
            asset_version,
            buyer: buyer.clone(),
            license_type,
            purchased_at: self.timestamp,
            calls_remaining,
            expires_at: 0,
            renewal_count: 0,
            grace_period_end: 0,
            auto_renew: false,
        };

        // Record Escrow Hold
        let hold_until_ledger = self.ledger_sequence + ESCROW_HOLD_LEDGERS;
        let escrow = EscrowHold {
            license_id,
            buyer: buyer.clone(),
            seller,
            token,
            amount: price,
            created_at: self.timestamp,
            created_ledger: self.ledger_sequence,
            hold_until_ledger,
            status: EscrowStatus::Held,
        };

        self.escrows.insert(license_id, escrow);
        self.licenses.insert(license_id, license.clone());
        self.buyer_licenses
            .insert((buyer.clone(), asset_id), license_id);

        if let Some(asset) = self.assets.get_mut(&asset_id) {
            asset.usage_count = asset.usage_count.saturating_add(1);
        }

        Ok(license)
    }

    /// Top up remaining calls on an existing usage-based license.
    ///
    /// Deducts `(asset.price * additional_calls + 99) / 100` tokens from the buyer.
    pub fn top_up_calls(
        &mut self,
        buyer: AccountId,
        asset_id: u64,
        token: TokenId,
        additional_calls: u64,
    ) -> Result<u64, ModelError> {
        if additional_calls == 0 {
            return Err(ModelError::InvalidAmount(0));
        }

        let license_id = self
            .buyer_licenses
            .get(&(buyer.clone(), asset_id))
            .copied()
            .ok_or(ModelError::LicenseNotFound)?;

        let price = {
            let asset = self
                .assets
                .get(&asset_id)
                .ok_or(ModelError::AssetNotFound(asset_id))?;
            asset.price
        };

        // Proportional price calculation based on standard 100-call quota
        let cost = if price > 0 {
            let num = price
                .saturating_mul(additional_calls as i128)
                .saturating_add(99);
            num / 100
        } else {
            0
        };

        if cost > 0 {
            let balance = self.get_balance(&buyer, &token);
            if balance < cost {
                return Err(ModelError::InsufficientBalance {
                    account: buyer,
                    token,
                    required: cost,
                    available: balance,
                });
            }
            self.set_balance(buyer, token, balance - cost);
        }

        let license = self
            .licenses
            .get_mut(&license_id)
            .ok_or(ModelError::LicenseNotFound)?;

        license.calls_remaining = license
            .calls_remaining
            .checked_add(additional_calls)
            .ok_or(ModelError::ArithmeticOverflow)?;

        Ok(license.calls_remaining)
    }

    /// Consume a call from a usage-based license.
    pub fn consume_call(&mut self, buyer: &AccountId, asset_id: u64) -> Result<u64, ModelError> {
        let license_id = self
            .buyer_licenses
            .get(&(buyer.clone(), asset_id))
            .copied()
            .ok_or(ModelError::LicenseNotFound)?;

        let license = self
            .licenses
            .get_mut(&license_id)
            .ok_or(ModelError::LicenseNotFound)?;

        if license.license_type == LicenseType::UsageBased {
            if license.calls_remaining == 0 {
                return Err(ModelError::NoCallsRemaining);
            }
            license.calls_remaining -= 1;
            Ok(license.calls_remaining)
        } else {
            Ok(license.calls_remaining)
        }
    }

    // ── Payment Streaming ────────────────────────────────────────────────────

    /// Open a new micropayment stream, locking `deposit` tokens from the sender.
    pub fn open_stream(
        &mut self,
        sender: AccountId,
        recipient: AccountId,
        token: TokenId,
        deposit: i128,
        rate_per_second: i128,
        duration_secs: u64,
    ) -> Result<u64, ModelError> {
        if deposit <= 0 {
            return Err(ModelError::InvalidAmount(deposit));
        }
        if rate_per_second <= 0 {
            return Err(ModelError::InvalidAmount(rate_per_second));
        }

        let sender_bal = self.get_balance(&sender, &token);
        if sender_bal < deposit {
            return Err(ModelError::InsufficientBalance {
                account: sender,
                token,
                required: deposit,
                available: sender_bal,
            });
        }
        self.set_balance(sender.clone(), token.clone(), sender_bal - deposit);

        let stream_id = self.next_stream_id;
        self.next_stream_id = self
            .next_stream_id
            .checked_add(1)
            .ok_or(ModelError::ArithmeticOverflow)?;

        let start_time = self.timestamp;
        let end_time = start_time.saturating_add(duration_secs);

        let stream = Stream {
            id: stream_id,
            sender,
            recipient,
            token,
            deposit,
            locked_amount: deposit,
            rate_per_second,
            start_time,
            end_time,
            last_settled: start_time,
            withdrawn: 0,
            status: StreamStatus::Active,
        };

        self.streams.insert(stream_id, stream);
        Ok(stream_id)
    }

    /// Recipient withdraws claimable funds from an active payment stream.
    pub fn withdraw_stream(
        &mut self,
        recipient: AccountId,
        stream_id: u64,
    ) -> Result<i128, ModelError> {
        let stream = self
            .streams
            .get_mut(&stream_id)
            .ok_or(ModelError::StreamNotFound(stream_id))?;

        if stream.recipient != recipient {
            return Err(ModelError::NotStreamRecipient {
                stream_id,
                caller: recipient,
            });
        }

        let amount = stream.claimable(self.timestamp);
        if amount <= 0 {
            return Ok(0);
        }

        stream.withdrawn = stream.withdrawn.saturating_add(amount);
        stream.locked_amount = stream.deposit.saturating_sub(stream.withdrawn);
        stream.last_settled = self.timestamp;

        if stream.withdrawn >= stream.deposit || self.timestamp >= stream.end_time {
            stream.status = StreamStatus::Completed;
        }

        let token = stream.token.clone();
        let recip_bal = self.get_balance(&recipient, &token);
        self.set_balance(recipient, token, recip_bal.saturating_add(amount));

        Ok(amount)
    }

    /// Sender cancels an active or paused stream; refunds unearned portion to sender.
    ///
    /// Returns `(earned_by_recipient, refunded_to_sender)`.
    pub fn cancel_stream(
        &mut self,
        sender: AccountId,
        stream_id: u64,
    ) -> Result<(i128, i128), ModelError> {
        let stream = self
            .streams
            .get_mut(&stream_id)
            .ok_or(ModelError::StreamNotFound(stream_id))?;

        if stream.sender != sender {
            return Err(ModelError::NotStreamSender {
                stream_id,
                caller: sender,
            });
        }
        if stream.status != StreamStatus::Active && stream.status != StreamStatus::Paused {
            return Err(ModelError::StreamNotActive(stream_id));
        }

        let earned = stream.claimable(self.timestamp);
        let refund = stream.deposit - stream.withdrawn - earned;

        stream.withdrawn = stream.withdrawn.saturating_add(earned);
        stream.locked_amount = 0;
        stream.status = StreamStatus::Cancelled;

        let token = stream.token.clone();
        let recipient = stream.recipient.clone();

        if earned > 0 {
            let recip_bal = self.get_balance(&recipient, &token);
            self.set_balance(recipient, token.clone(), recip_bal.saturating_add(earned));
        }
        if refund > 0 {
            let sender_bal = self.get_balance(&sender, &token);
            self.set_balance(sender, token, sender_bal.saturating_add(refund));
        }

        Ok((earned, refund))
    }

    /// Pause an active payment stream (sender only).
    pub fn pause_stream(&mut self, sender: AccountId, stream_id: u64) -> Result<(), ModelError> {
        let stream = self
            .streams
            .get_mut(&stream_id)
            .ok_or(ModelError::StreamNotFound(stream_id))?;

        if stream.sender != sender {
            return Err(ModelError::NotStreamSender {
                stream_id,
                caller: sender,
            });
        }
        if stream.status != StreamStatus::Active {
            return Err(ModelError::StreamNotActive(stream_id));
        }

        stream.status = StreamStatus::Paused;
        Ok(())
    }

    /// Resume a paused payment stream (sender only).
    pub fn resume_stream(&mut self, sender: AccountId, stream_id: u64) -> Result<(), ModelError> {
        let stream = self
            .streams
            .get_mut(&stream_id)
            .ok_or(ModelError::StreamNotFound(stream_id))?;

        if stream.sender != sender {
            return Err(ModelError::NotStreamSender {
                stream_id,
                caller: sender,
            });
        }
        if stream.status != StreamStatus::Paused {
            return Err(ModelError::StreamNotActive(stream_id));
        }

        stream.status = StreamStatus::Active;
        stream.last_settled = self.timestamp;
        Ok(())
    }

    // ── Queries ──────────────────────────────────────────────────────────────

    /// Retrieve an asset by its ID.
    pub fn get_asset(&self, asset_id: u64) -> Option<&Asset> {
        self.assets.get(&asset_id)
    }

    /// Retrieve the version history for an asset.
    pub fn get_asset_history(&self, asset_id: u64) -> Vec<AssetVersion> {
        self.asset_history
            .get(&asset_id)
            .cloned()
            .unwrap_or_default()
    }

    /// Retrieve a buyer's license for an asset.
    pub fn get_license(&self, buyer: &AccountId, asset_id: u64) -> Option<&License> {
        let license_id = self.buyer_licenses.get(&(buyer.clone(), asset_id))?;
        self.licenses.get(license_id)
    }

    /// Check if a buyer holds a license for an asset.
    pub fn has_license(&self, buyer: &AccountId, asset_id: u64) -> bool {
        self.buyer_licenses.contains_key(&(buyer.clone(), asset_id))
    }

    /// Retrieve a stream by its ID.
    pub fn get_stream(&self, stream_id: u64) -> Option<&Stream> {
        self.streams.get(&stream_id)
    }

    /// Retrieve an escrow hold by license ID.
    pub fn get_escrow(&self, license_id: u64) -> Option<&EscrowHold> {
        self.escrows.get(&license_id)
    }

    /// Release held escrow funds to the seller after the hold window expires.
    pub fn release_escrow(&mut self, license_id: u64) -> Result<(), ModelError> {
        let escrow = self
            .escrows
            .get_mut(&license_id)
            .ok_or(ModelError::EscrowNotFound(license_id))?;

        if escrow.status != EscrowStatus::Held {
            return Err(ModelError::EscrowAlreadyReleased(license_id));
        }

        let token = escrow.token.clone();
        let seller = escrow.seller.clone();
        let amount = escrow.amount;
        escrow.status = EscrowStatus::Released;

        let seller_bal = self.get_balance(&seller, &token);
        self.set_balance(seller, token, seller_bal.saturating_add(amount));

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NATIVE_TOKEN: &str = "XLM";

    #[test]
    fn test_list_asset_and_publish_update() {
        let mut state = State::new();
        let owner = "alice".to_string();

        let asset_id = state
            .list_asset(
                owner.clone(),
                "Agent Prompt".to_string(),
                "Initial prompt description".to_string(),
                AssetType::Prompt,
                LicenseType::Perpetual,
                500,
                vec!["ai".to_string(), "v1".to_string()],
            )
            .expect("should list asset");

        assert_eq!(asset_id, 1);
        let asset = state.get_asset(asset_id).unwrap();
        assert_eq!(asset.version, 1);
        assert_eq!(asset.price, 500);
        assert_eq!(asset.reputation, DEFAULT_REPUTATION);

        let history = state.get_asset_history(asset_id);
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].description, "Initial prompt description");

        // Update description across 6 versions to verify HISTORY_LIMIT = 5
        for i in 2..=7 {
            state
                .publish_update(owner.clone(), asset_id, format!("Description v{}", i))
                .expect("should publish update");
        }

        let updated_asset = state.get_asset(asset_id).unwrap();
        assert_eq!(updated_asset.version, 7);
        assert_eq!(updated_asset.description, "Description v7");

        let updated_history = state.get_asset_history(asset_id);
        assert_eq!(updated_history.len(), 5);
        assert_eq!(updated_history[0].version, 3);
        assert_eq!(updated_history[4].version, 7);
    }

    #[test]
    fn test_list_asset_bounds_and_validations() {
        let mut state = State::new();
        let owner = "alice".to_string();

        // Zero price rejected
        let res = state.list_asset(
            owner.clone(),
            "Name".into(),
            "Desc".into(),
            AssetType::Prompt,
            LicenseType::Perpetual,
            0,
            vec![],
        );
        assert_eq!(res, Err(ModelError::InvalidPrice(0)));

        // Negative price rejected
        let res = state.list_asset(
            owner.clone(),
            "Name".into(),
            "Desc".into(),
            AssetType::Prompt,
            LicenseType::Perpetual,
            -10,
            vec![],
        );
        assert_eq!(res, Err(ModelError::InvalidPrice(-10)));

        // Empty name rejected
        let res = state.list_asset(
            owner.clone(),
            "".into(),
            "Desc".into(),
            AssetType::Prompt,
            LicenseType::Perpetual,
            100,
            vec![],
        );
        assert!(matches!(res, Err(ModelError::InvalidMetadata(_))));

        // Name too long (> 200 bytes) rejected
        let long_name = "a".repeat(201);
        let res = state.list_asset(
            owner.clone(),
            long_name,
            "Desc".into(),
            AssetType::Prompt,
            LicenseType::Perpetual,
            100,
            vec![],
        );
        assert!(matches!(res, Err(ModelError::InvalidMetadata(_))));

        // Description too long (> 2000 bytes) rejected
        let long_desc = "d".repeat(2001);
        let res = state.list_asset(
            owner.clone(),
            "Name".into(),
            long_desc,
            AssetType::Prompt,
            LicenseType::Perpetual,
            100,
            vec![],
        );
        assert!(matches!(res, Err(ModelError::InvalidMetadata(_))));
    }

    #[test]
    fn test_purchase_license_and_top_up() {
        let mut state = State::new();
        let seller = "alice".to_string();
        let buyer = "bob".to_string();
        let token = NATIVE_TOKEN.to_string();

        let asset_id = state
            .list_asset(
                seller.clone(),
                "Usage Agent".to_string(),
                "Pay per call agent".to_string(),
                AssetType::Tool,
                LicenseType::UsageBased,
                100,
                vec![],
            )
            .unwrap();

        // Self purchase rejected
        let self_res = state.purchase_license(seller.clone(), asset_id, token.clone());
        assert_eq!(self_res, Err(ModelError::SelfPurchase));

        // Insufficient balance rejected
        let no_bal_res = state.purchase_license(buyer.clone(), asset_id, token.clone());
        assert!(matches!(
            no_bal_res,
            Err(ModelError::InsufficientBalance { .. })
        ));

        // Mint funds for buyer
        state.mint(buyer.clone(), token.clone(), 1_000);
        assert_eq!(state.get_balance(&buyer, &token), 1_000);

        // Buyer purchases usage-based license
        let license = state
            .purchase_license(buyer.clone(), asset_id, token.clone())
            .expect("purchase license");
        assert_eq!(license.calls_remaining, 100);
        assert_eq!(state.get_balance(&buyer, &token), 900);
        assert!(state.has_license(&buyer, asset_id));

        // Escrow hold recorded
        let escrow = state.get_escrow(license.id).unwrap();
        assert_eq!(escrow.amount, 100);
        assert_eq!(escrow.status, EscrowStatus::Held);

        // Consume calls
        let remaining = state.consume_call(&buyer, asset_id).unwrap();
        assert_eq!(remaining, 99);

        // Top up 50 calls
        let new_calls = state
            .top_up_calls(buyer.clone(), asset_id, token.clone(), 50)
            .expect("top up calls");
        assert_eq!(new_calls, 149);
        // Cost for 50 calls @ price 100: (100 * 50 + 99) / 100 = 50
        assert_eq!(state.get_balance(&buyer, &token), 850);

        // Release escrow
        state.release_escrow(license.id).expect("release escrow");
        assert_eq!(state.get_balance(&seller, &token), 100);
    }

    #[test]
    fn test_open_and_withdraw_stream() {
        let mut state = State::new();
        let sender = "alice".to_string();
        let recipient = "bob".to_string();
        let token = NATIVE_TOKEN.to_string();

        state.mint(sender.clone(), token.clone(), 500);

        let stream_id = state
            .open_stream(
                sender.clone(),
                recipient.clone(),
                token.clone(),
                300,
                10,
                30,
            )
            .expect("open stream");

        assert_eq!(stream_id, 1);
        assert_eq!(state.get_balance(&sender, &token), 200);

        let stream = state.get_stream(stream_id).unwrap();
        assert_eq!(stream.locked_amount, 300);

        // Fast forward 10 seconds
        state.timestamp += 10;
        let withdrawn = state
            .withdraw_stream(recipient.clone(), stream_id)
            .expect("withdraw stream");
        assert_eq!(withdrawn, 100);
        assert_eq!(state.get_balance(&recipient, &token), 100);

        let stream_after = state.get_stream(stream_id).unwrap();
        assert_eq!(stream_after.locked_amount, 200);
        assert_eq!(stream_after.withdrawn, 100);
    }

    #[test]
    fn test_pause_resume_cancel_stream() {
        let mut state = State::new();
        let sender = "alice".to_string();
        let recipient = "bob".to_string();
        let token = NATIVE_TOKEN.to_string();

        state.mint(sender.clone(), token.clone(), 1_000);

        let stream_id = state
            .open_stream(
                sender.clone(),
                recipient.clone(),
                token.clone(),
                500,
                10,
                50,
            )
            .unwrap();

        // Pause stream
        state
            .pause_stream(sender.clone(), stream_id)
            .expect("pause");
        let s = state.get_stream(stream_id).unwrap();
        assert_eq!(s.status, StreamStatus::Paused);

        // Resume stream
        state.timestamp += 10;
        state
            .resume_stream(sender.clone(), stream_id)
            .expect("resume");
        let s = state.get_stream(stream_id).unwrap();
        assert_eq!(s.status, StreamStatus::Active);

        // Advance 20 seconds and cancel
        state.timestamp += 20;
        let (earned, refund) = state
            .cancel_stream(sender.clone(), stream_id)
            .expect("cancel");
        assert_eq!(earned, 200);
        assert_eq!(refund, 300);
        assert_eq!(state.get_balance(&sender, &token), 800);
        assert_eq!(state.get_balance(&recipient, &token), 200);
    }

    #[test]
    fn test_transfer_asset() {
        let mut state = State::new();
        let alice = "alice".to_string();
        let bob = "bob".to_string();
        let stranger = "stranger".to_string();

        let asset_id = state
            .list_asset(
                alice.clone(),
                "Reasoning Flow".to_string(),
                "Chain of thought flow".to_string(),
                AssetType::ReasoningChain,
                LicenseType::Perpetual,
                250,
                vec![],
            )
            .unwrap();

        // Non-owner cannot transfer
        let err = state.transfer_asset(stranger, bob.clone(), asset_id);
        assert!(matches!(err, Err(ModelError::NotAssetOwner { .. })));

        // Owner transfers
        state
            .transfer_asset(alice, bob.clone(), asset_id)
            .expect("transfer asset");

        let asset = state.get_asset(asset_id).unwrap();
        assert_eq!(asset.owner, bob);
    }

    #[test]
    fn test_delist_and_update_price() {
        let mut state = State::new();
        let owner = "alice".to_string();

        let asset_id = state
            .list_asset(
                owner.clone(),
                "Tool".to_string(),
                "A tool".to_string(),
                AssetType::Tool,
                LicenseType::Perpetual,
                100,
                vec![],
            )
            .unwrap();

        state
            .update_price(owner.clone(), asset_id, 200)
            .expect("update price");
        assert_eq!(state.get_asset(asset_id).unwrap().price, 200);

        state
            .delist_asset(owner.clone(), asset_id)
            .expect("delist asset");
        assert!(!state.get_asset(asset_id).unwrap().is_active);

        // Cannot update price of inactive asset
        let res = state.update_price(owner, asset_id, 300);
        assert_eq!(res, Err(ModelError::AssetInactive(asset_id)));
    }
}
