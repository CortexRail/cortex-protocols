//! Invariant Suite and Action Definitions for Differential Fuzzing.
//!
//! This module defines the `Action` enum representing all state-mutating operations
//! across the marketplace and micropayments protocols, and provides the complete suite
//! of invariants checked after each transition during differential fuzzing.

#![allow(dead_code, unused_imports)]

#[path = "../model/mod.rs"]
pub mod model;

pub use model::*;

pub mod asset_ownership;
pub mod escrow_conservation;
pub mod license_monotonicity;
pub mod reputation_bounds;

pub use asset_ownership::check_asset_ownership;
pub use escrow_conservation::{check_escrow_conservation, check_token_value_conservation};
pub use license_monotonicity::check_license_monotonicity;
pub use reputation_bounds::{check_reputation_bounds, MAX_REPUTATION, MIN_REPUTATION};

/// State-mutating actions executed by differential fuzzing harnesses.
#[derive(Clone, Debug, PartialEq, arbitrary::Arbitrary)]
pub enum Action {
    /// List a new intelligence asset.
    ListAsset {
        owner: AccountId,
        name: String,
        description: String,
        asset_type: AssetType,
        license_type: LicenseType,
        price: i128,
        tags: Vec<String>,
    },
    /// Open a new micropayments stream.
    OpenStream {
        sender: AccountId,
        recipient: AccountId,
        token: TokenId,
        deposit: i128,
        rate_per_second: i128,
        duration_secs: u64,
    },
    /// Publish an updated asset description and advance its version.
    PublishUpdate {
        owner: AccountId,
        asset_id: u64,
        new_description: String,
    },
    /// Purchase an asset license for the latest version.
    PurchaseLicense {
        buyer: AccountId,
        asset_id: u64,
        token: TokenId,
    },
    /// Purchase an asset license pinned to a specific retained version.
    PurchaseLicenseVersion {
        buyer: AccountId,
        asset_id: u64,
        asset_version: u32,
        token: TokenId,
    },
    /// Top up remaining calls for a usage-based license.
    TopUpCalls {
        buyer: AccountId,
        asset_id: u64,
        token: TokenId,
        additional_calls: u64,
    },
    /// Transfer asset ownership to a new account.
    TransferAsset {
        current_owner: AccountId,
        new_owner: AccountId,
        asset_id: u64,
    },
    /// Consume a single call from a usage-based license.
    ConsumeCall { buyer: AccountId, asset_id: u64 },
    /// Delist or deactivate an asset.
    DelistAsset { owner: AccountId, asset_id: u64 },
    /// Update the listed price of an active asset.
    UpdatePrice {
        owner: AccountId,
        asset_id: u64,
        new_price: i128,
    },
    /// Withdraw claimable funds from an active payment stream.
    WithdrawStream {
        recipient: AccountId,
        stream_id: u64,
    },
    /// Cancel a payment stream and refund unearned funds.
    CancelStream { sender: AccountId, stream_id: u64 },
    /// Pause an active payment stream.
    PauseStream { sender: AccountId, stream_id: u64 },
    /// Resume a paused payment stream.
    ResumeStream { sender: AccountId, stream_id: u64 },
    /// Release held escrow funds to the seller after the hold window expires.
    ReleaseEscrow { license_id: u64 },
    /// Mint tokens to an account for testing state sequences.
    Mint {
        account: AccountId,
        token: TokenId,
        amount: i128,
    },
    /// Advance simulated ledger time and sequence number.
    AdvanceLedger { seconds: u64, ledgers: u32 },
}

/// Result of executing an `Action` on the reference model.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ActionResult {
    AssetListed(u64),
    StreamOpened(u64),
    UpdatePublished,
    LicensePurchased(u64),
    CallsToppedUp(u64),
    AssetTransferred,
    CallConsumed(u64),
    AssetDelisted,
    PriceUpdated,
    StreamWithdrawn(i128),
    StreamCancelled { earned: i128, refund: i128 },
    StreamPaused,
    StreamResumed,
    EscrowReleased,
    Minted,
    LedgerAdvanced,
}

impl Action {
    /// Execute this action against a reference `State`.
    pub fn apply(&self, state: &mut State) -> Result<ActionResult, ModelError> {
        match self {
            Action::ListAsset {
                owner,
                name,
                description,
                asset_type,
                license_type,
                price,
                tags,
            } => {
                let asset_id = state.list_asset(
                    owner.clone(),
                    name.clone(),
                    description.clone(),
                    asset_type.clone(),
                    license_type.clone(),
                    *price,
                    tags.clone(),
                )?;
                Ok(ActionResult::AssetListed(asset_id))
            }
            Action::OpenStream {
                sender,
                recipient,
                token,
                deposit,
                rate_per_second,
                duration_secs,
            } => {
                let stream_id = state.open_stream(
                    sender.clone(),
                    recipient.clone(),
                    token.clone(),
                    *deposit,
                    *rate_per_second,
                    *duration_secs,
                )?;
                Ok(ActionResult::StreamOpened(stream_id))
            }
            Action::PublishUpdate {
                owner,
                asset_id,
                new_description,
            } => {
                state.publish_update(owner.clone(), *asset_id, new_description.clone())?;
                Ok(ActionResult::UpdatePublished)
            }
            Action::PurchaseLicense {
                buyer,
                asset_id,
                token,
            } => {
                let lic = state.purchase_license(buyer.clone(), *asset_id, token.clone())?;
                Ok(ActionResult::LicensePurchased(lic.id))
            }
            Action::PurchaseLicenseVersion {
                buyer,
                asset_id,
                asset_version,
                token,
            } => {
                let lic = state.purchase_license_version(
                    buyer.clone(),
                    *asset_id,
                    *asset_version,
                    token.clone(),
                )?;
                Ok(ActionResult::LicensePurchased(lic.id))
            }
            Action::TopUpCalls {
                buyer,
                asset_id,
                token,
                additional_calls,
            } => {
                let remaining = state.top_up_calls(
                    buyer.clone(),
                    *asset_id,
                    token.clone(),
                    *additional_calls,
                )?;
                Ok(ActionResult::CallsToppedUp(remaining))
            }
            Action::TransferAsset {
                current_owner,
                new_owner,
                asset_id,
            } => {
                state.transfer_asset(current_owner.clone(), new_owner.clone(), *asset_id)?;
                Ok(ActionResult::AssetTransferred)
            }
            Action::ConsumeCall { buyer, asset_id } => {
                let rem = state.consume_call(buyer, *asset_id)?;
                Ok(ActionResult::CallConsumed(rem))
            }
            Action::DelistAsset { owner, asset_id } => {
                state.delist_asset(owner.clone(), *asset_id)?;
                Ok(ActionResult::AssetDelisted)
            }
            Action::UpdatePrice {
                owner,
                asset_id,
                new_price,
            } => {
                state.update_price(owner.clone(), *asset_id, *new_price)?;
                Ok(ActionResult::PriceUpdated)
            }
            Action::WithdrawStream {
                recipient,
                stream_id,
            } => {
                let amt = state.withdraw_stream(recipient.clone(), *stream_id)?;
                Ok(ActionResult::StreamWithdrawn(amt))
            }
            Action::CancelStream { sender, stream_id } => {
                let (earned, refund) = state.cancel_stream(sender.clone(), *stream_id)?;
                Ok(ActionResult::StreamCancelled { earned, refund })
            }
            Action::PauseStream { sender, stream_id } => {
                state.pause_stream(sender.clone(), *stream_id)?;
                Ok(ActionResult::StreamPaused)
            }
            Action::ResumeStream { sender, stream_id } => {
                state.resume_stream(sender.clone(), *stream_id)?;
                Ok(ActionResult::StreamResumed)
            }
            Action::ReleaseEscrow { license_id } => {
                state.release_escrow(*license_id)?;
                Ok(ActionResult::EscrowReleased)
            }
            Action::Mint {
                account,
                token,
                amount,
            } => {
                if *amount > 0 {
                    state.mint(account.clone(), token.clone(), *amount);
                }
                Ok(ActionResult::Minted)
            }
            Action::AdvanceLedger { seconds, ledgers } => {
                state.timestamp = state.timestamp.saturating_add(*seconds);
                state.ledger_sequence = state.ledger_sequence.saturating_add(*ledgers);
                Ok(ActionResult::LedgerAdvanced)
            }
        }
    }
}

/// Run all protocol invariants against the post-transition state.
pub fn check_all_invariants(before: &State, after: &State, action: &Action) {
    check_escrow_conservation(after);
    check_license_monotonicity(before, after, action);
    check_reputation_bounds(after);
    check_asset_ownership(before, after, action);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_invariants_suite_on_sequential_actions() {
        let mut state = State::new();
        let token = "XLM".to_string();
        state.mint("alice".into(), token.clone(), 10_000);
        state.mint("bob".into(), token.clone(), 10_000);

        let actions = vec![
            Action::ListAsset {
                owner: "alice".into(),
                name: "Neural Model".into(),
                description: "Deep reasoning tool".into(),
                asset_type: AssetType::ReasoningChain,
                license_type: LicenseType::UsageBased,
                price: 200,
                tags: vec!["ai".into()],
            },
            Action::OpenStream {
                sender: "bob".into(),
                recipient: "alice".into(),
                token: token.clone(),
                deposit: 1_000,
                rate_per_second: 50,
                duration_secs: 20,
            },
            Action::PurchaseLicense {
                buyer: "bob".into(),
                asset_id: 1,
                token: token.clone(),
            },
            Action::TopUpCalls {
                buyer: "bob".into(),
                asset_id: 1,
                token: token.clone(),
                additional_calls: 100,
            },
            Action::TransferAsset {
                current_owner: "alice".into(),
                new_owner: "charlie".into(),
                asset_id: 1,
            },
            Action::PublishUpdate {
                owner: "charlie".into(),
                asset_id: 1,
                new_description: "Updated description by new owner".into(),
            },
        ];

        for action in actions {
            let before = state.clone();
            action.apply(&mut state).expect("action must succeed");
            check_all_invariants(&before, &state, &action);
        }
    }
}
