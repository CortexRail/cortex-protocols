use soroban_sdk::contracterror;

/// Errors returned by the Marketplace contract.
///
/// Error codes are stable and should not be changed once the contract
/// is deployed, as clients may rely on their numeric values.
#[contracterror]
#[derive(Clone, Debug, Copy, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum MarketplaceError {
    /// Caller is not the asset owner.
    NotOwner = 1,

    /// Asset does not exist.
    AssetNotFound = 2,

    /// Asset is inactive or unavailable.
    AssetInactive = 3,

    /// Buyers cannot purchase their own assets.
    SelfPurchase = 4,

    /// Price must be greater than zero.
    InvalidPrice = 5,

    /// Maximum number of assets has been reached.
    AssetLimitReached = 6,

    /// Buyer already owns a license for this asset.
    LicenseAlreadyExists = 7,

    /// Caller is not authorized to perform this action.
    Unauthorized = 8,

    /// Required asset metadata is missing or invalid.
    InvalidMetadata = 9,

    /// Payment amount does not match the asset price.
    InvalidPayment = 10,

    /// Asset has already been purchased or licensed.
    AlreadyPurchased = 11,

    /// Asset is already listed.
    AlreadyListed = 12,

    /// Asset is not currently listed.
    NotListed = 13,

    /// Listing cannot be modified in its current state.
    InvalidAssetState = 14,

    /// Arithmetic overflow or underflow occurred.
    ArithmeticError = 15,

    /// Auction does not exist.
    AuctionNotFound = 16,

    /// Auction is not in the phase required by the operation.
    AuctionPhaseError = 17,

    /// Bidder has not committed a bid for this auction.
    BidNotCommitted = 18,

    /// Revealed bid does not match the committed bid hash.
    CommitmentMismatch = 19,

    /// Bid amount is invalid (below reserve or non-positive).
    InvalidBidAmount = 20,

    /// Auction parameters are invalid (e.g. zero capacity or duration).
    InvalidAuctionParams = 21,

    /// Bidder has already revealed a bid for this auction.
    BidAlreadyRevealed = 22,

    /// Reveal uses a different payment token than the auction escrow.
    TokenMismatch = 23,
}
