use soroban_sdk::contracterror;

/// Errors returned by the Channels contract.
///
/// Error codes are stable and should not be changed once the contract
/// is deployed, as clients may rely on their numeric values.
#[contracterror]
#[derive(Clone, Debug, Copy, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ChannelsError {
    /// Caller has not registered an Ed25519 key for off-chain state signing.
    ChannelKeyNotRegistered = 1,

    /// Deposits must be positive.
    InvalidDeposit = 2,

    /// The two channel parties must be different addresses.
    SelfChannel = 3,

    /// Channel does not exist.
    ChannelNotFound = 4,

    /// Caller is not a party to this channel.
    NotAParty = 5,

    /// Channel is not in the `Open` state.
    ChannelNotOpen = 6,

    /// Channel is not in the `Closing` state.
    ChannelNotClosing = 7,

    /// The state's `channel_id` does not match the channel being acted on.
    ChannelIdMismatch = 8,

    /// The submitted state does not carry both valid signatures.
    InvalidStateSignature = 9,

    /// Balances in the submitted state do not sum to the channel's total
    /// deposit — funds would be created or destroyed.
    BalanceConservationViolated = 10,

    /// A dispute's state version must be strictly greater than the version
    /// currently pending on-chain.
    VersionNotHigher = 11,

    /// The dispute window has not yet elapsed.
    DisputeWindowOpen = 12,

    /// The revealed secret does not open either party's revocation
    /// commitment for the pending state.
    InvalidRevocationSecret = 13,

    /// `punish`'s caller must be the channel party who did not initiate the
    /// disputed unilateral close.
    NotTheHonestParty = 14,
}
