use soroban_sdk::contracterror;

/// Marketplace contract errors.
#[contracterror]
#[derive(Clone, Debug, Copy, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum MarketplaceError {
    NotOwner = 1,
    AssetNotFound = 2,
    AssetInactive = 3,
    SelfPurchase = 4,
    InvalidPrice = 5,
    AssetLimitReached = 6,
    LicenseAlreadyExists = 7,
    Unauthorized = 8,
    InvalidMetadata = 9,
    InvalidPayment = 10,
    AlreadyPurchased = 11,
    AlreadyListed = 12,
    NotListed = 13,
    InvalidAssetState = 14,
    ArithmeticError = 15,
    EscrowAlreadyReleased = 16,
    DisputeWindowClosed = 17,
    NotArbitrator = 18,
    EscrowNotFound = 19,
    EscrowDisputed = 20,
    DisputeNotFound = 21,
    DisputeAlreadyResolved = 22,
    InvalidRefundBps = 23,
    NoArbitratorVotes = 24,
    AuctionNotFound = 25,
    AuctionPhaseError = 26,
    BidNotCommitted = 27,
    CommitmentMismatch = 28,
    InvalidBidAmount = 29,
    InvalidAuctionParams = 30,
    LicenseNotFound = 31,
    InvalidSubscriptionPeriod = 32,
    SubscriptionExpired = 33,
    SubscriptionNotActive = 34,
    ProrationError = 35,
    BidAlreadyRevealed = 36,

    /// Policy not found.
    PolicyNotFound = 37,

    /// Invalid threshold or required signers.
    InvalidThreshold = 38,

    /// Proposal not found.
    ProposalNotFound = 39,

    /// Base fee exceeds the buyer's maximum acceptable ceiling.
    BaseFeeExceedsMax = 40,

    /// Base fee update already performed for this window.
    WindowAlreadyUpdated = 41,

    /// Requested capacity exceeds window capacity limit.
    CapacityExceeded = 42,

    DisputeNotActive = 43,
    ArbiterNotFound = 44,
    InvalidRuling = 45,
    TokenMismatch = 46,
    DisputeNotFinalRound = 47,
    ResponseWindowExpired = 48,
    RevealWindowExpired = 49,
    AlreadyRevealed = 50,
    ProposalNotPending = 51,
    NotASigner = 52,
    SignerAlreadyApproved = 53,
    BondNotFound = 54,
    InsufficientBond = 55,
    BondWithdrawalBlocked = 56,
    UnknownError = 57,
}
