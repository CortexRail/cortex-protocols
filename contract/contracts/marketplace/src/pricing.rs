use soroban_sdk::{contracttype, Address, String, Vec};

/// Price commitment for multi-asset settlement with slippage protection
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceCommitment {
    pub asset_id: u64,
    pub token: Address,
    /// USD price in cents (e.g., 4200 for $42.00)
    pub usd_price_cents: u64,
    /// Maximum acceptable price with slippage (in token base units)
    pub max_price: i128,
    /// Valid until this ledger sequence
    pub valid_until_ledger: u32,
    /// Backend-provided signature for replay protection
    pub signature: Vec<u8>,
}

/// Asset with multi-token support
#[contracttype]
#[derive(Clone, Debug)]
pub struct MultiAssetListing {
    pub asset_id: u64,
    pub owner: Address,
    pub name: String,
    pub description: String,
    pub asset_type: u32, // AssetType enum
    pub license_type: u32, // LicenseType enum
    /// USD price in cents (converted from base token)
    pub usd_price_cents: u64,
    /// Accepted payment tokens (addresses)
    pub accepted_tokens: Vec<Address>,
    pub usage_count: u64,
    pub is_active: bool,
    pub created_at: u64,
    pub version: u32,
}

/// Errors for pricing operations
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PricingError {
    TokenNotAccepted = 1,
    PriceCommitmentExpired = 2,
    SlippageExceeded = 3,
    InvalidCommitment = 4,
    OracleUnavailable = 5,
}

/// Validate price commitment hasn't expired
pub fn validate_commitment_ledger(commitment: &PriceCommitment, current_ledger: u32) -> Result<(), PricingError> {
    if current_ledger >= commitment.valid_until_ledger {
        return Err(PricingError::PriceCommitmentExpired);
    }
    Ok(())
}

/// Validate token is in accepted list
pub fn validate_token_accepted(
    token: &Address,
    accepted_tokens: &Vec<Address>,
) -> Result<(), PricingError> {
    for accepted in accepted_tokens.iter() {
        if accepted == token {
            return Ok(());
        }
    }
    Err(PricingError::TokenNotAccepted)
}

/// Check actual price against slippage tolerance
pub fn check_slippage(actual_price: i128, max_price: i128) -> Result<(), PricingError> {
    if actual_price > max_price {
        return Err(PricingError::SlippageExceeded);
    }
    Ok(())
}
