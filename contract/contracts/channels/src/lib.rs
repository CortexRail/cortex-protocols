#![no_std]

//! Bidirectional payment channels for Intelligence Rail.
//!
//! Two parties exchange signed balance updates entirely off-chain (see
//! `backend/src/channels/ChannelState.js` / `ChannelNegotiator.js`); this
//! contract is touched only to open, to close cooperatively, or to
//! adjudicate a dispute. The hard part is not the happy path — it is
//! guaranteeing that a party who goes offline cannot be robbed by a
//! counterparty publishing a stale, more favourable state.
//!
//! ## The dispute lifecycle
//!
//! ```text
//! Open --close_unilateral--> Closing --(dispute window elapses)--> Closed
//!                                |
//!                                | dispute (higher version supersedes)
//!                                v
//!                             Closing (same window, corrected state)
//!                                |
//!                                | punish (revoked state proven)
//!                                v
//!                             Closed (challenger takes everything)
//! ```
//!
//! `close_cooperative` can short-circuit straight to `Closed` from either
//! `Open` or `Closing` — both parties agreeing always trumps a pending
//! dispute, since fresh dual signatures are strictly stronger evidence of
//! intent than anything already on-chain.
//!
//! ## Why `dispute` and `punish` are different entrypoints
//!
//! `dispute` requires the challenger to actually hold the later signed
//! state — it corrects the outcome to what was honestly agreed, nothing
//! more. `punish` requires only a revealed revocation secret — proof that
//! *some* later state existed, without needing its contents — and pays the
//! challenger the entire channel balance as a deterrent. This second, harsher
//! path is what lets a Watchtower (`backend/src/channels/Watchtower.js`) act
//! for an offline party while never learning that party's balances: it holds
//! an encrypted justice transaction keyed by `commitment_hash`, and a secret,
//! and nothing else. See `state.rs` for exactly what is signed and hashed.

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, token, Address, Bytes, BytesN, Env, Symbol,
};

mod errors;
mod state;

pub use errors::ChannelsError;
pub use state::ChannelState;
use state::{commitment_hash as state_commitment_hash, verify_dual_signature};

/// How long a unilateral close can be disputed before it finalizes, in
/// seconds. Mirrors `CHALLENGE_WINDOW_SECS`'s reasoning in micropayments:
/// long enough for an offline party (or their watchtower) to notice and
/// react, short enough that a stale close is not a viable griefing vector.
pub const DISPUTE_WINDOW_SECS: u64 = 86_400;

const NEXT_ID: Symbol = symbol_short!("CH_NEXT");

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ChannelStatus {
    Open,
    Closing,
    Closed,
}

/// A channel's durable, rarely-changing record: who, what token, how much
/// was deposited, and its current lifecycle status. The high-frequency
/// off-chain balance updates never touch this — see `PendingClose` for the
/// only balance state the chain ever needs to hold, and only while disputed.
#[contracttype]
#[derive(Clone, Debug)]
pub struct Channel {
    pub id: u64,
    pub party_a: Address,
    pub party_b: Address,
    pub token: Address,
    pub deposit_a: i128,
    pub deposit_b: i128,
    pub status: ChannelStatus,
}

/// The state a unilateral close is currently resting on, live only while
/// `status == Closing`. Replaced wholesale by `dispute`, consumed by
/// `force_close` or `punish`.
#[contracttype]
#[derive(Clone, Debug)]
pub struct PendingClose {
    pub closer: Address,
    pub dispute_deadline: u64,
    pub version: u64,
    pub balance_a: u64,
    pub balance_b: u64,
    pub revocation_commit_a: BytesN<32>,
    pub revocation_commit_b: BytesN<32>,
}

#[contracttype]
pub enum ChannelKey {
    Channel(u64),
    PendingClose(u64),
    /// Address -> the Ed25519 key its off-chain channel states are signed
    /// with. Registered once per address, reused across every channel that
    /// address opens — mirrors `AttKey::SellerKey` in micropayments.
    ChannelPubKey(Address),
}

// ── Storage helpers ──────────────────────────────────────────────────────────

fn load_channel(env: &Env, channel_id: u64) -> Result<Channel, ChannelsError> {
    env.storage()
        .persistent()
        .get(&ChannelKey::Channel(channel_id))
        .ok_or(ChannelsError::ChannelNotFound)
}

fn save_channel(env: &Env, channel: &Channel) {
    env.storage()
        .persistent()
        .set(&ChannelKey::Channel(channel.id), channel);
}

fn load_pending(env: &Env, channel_id: u64) -> PendingClose {
    env.storage()
        .persistent()
        .get(&ChannelKey::PendingClose(channel_id))
        .expect("channel is Closing but has no pending close on record")
}

fn save_pending(env: &Env, channel_id: u64, pending: &PendingClose) {
    env.storage()
        .persistent()
        .set(&ChannelKey::PendingClose(channel_id), pending);
}

fn registered_key(env: &Env, party: &Address) -> BytesN<32> {
    env.storage()
        .persistent()
        .get(&ChannelKey::ChannelPubKey(party.clone()))
        .expect("channel party has no registered key; open_channel should have required this")
}

fn require_party(channel: &Channel, who: &Address) -> Result<(), ChannelsError> {
    if who == &channel.party_a || who == &channel.party_b {
        Ok(())
    } else {
        Err(ChannelsError::NotAParty)
    }
}

/// Balances in a state must sum to exactly what the channel holds — nothing
/// created, nothing destroyed. Checked on every state the chain accepts
/// (unilateral close, dispute, cooperative close), not just at the end,
/// since a bad split off-chain should be rejected outright rather than
/// allowed to open a dispute window over impossible funds math.
fn require_conserved(
    channel: &Channel,
    balance_a: u64,
    balance_b: u64,
) -> Result<(), ChannelsError> {
    let total = channel.deposit_a + channel.deposit_b;
    if (balance_a as i128) + (balance_b as i128) == total {
        Ok(())
    } else {
        Err(ChannelsError::BalanceConservationViolated)
    }
}

fn pay(env: &Env, token: &Address, to: &Address, amount: i128) {
    if amount > 0 {
        token::Client::new(env, token).transfer(&env.current_contract_address(), to, &amount);
    }
}

#[contract]
pub struct ChannelsContract;

#[contractimpl]
impl ChannelsContract {
    // ── Configuration ────────────────────────────────────────────────────

    /// Register the Ed25519 key this address signs off-chain channel states
    /// with. `require_auth` means only the address itself can bind a key to
    /// itself — the same reasoning as micropayments'
    /// `register_attestation_key`. Must be called before that address can be
    /// a party to `open_channel`.
    pub fn register_channel_key(env: Env, party: Address, public_key: BytesN<32>) {
        party.require_auth();
        env.storage()
            .persistent()
            .set(&ChannelKey::ChannelPubKey(party.clone()), &public_key);

        env.events().publish(
            (Symbol::new(&env, "CHANNEL_KEY_REGISTERED"), party),
            public_key,
        );
    }

    pub fn get_channel_key(env: Env, party: Address) -> Option<BytesN<32>> {
        env.storage()
            .persistent()
            .get(&ChannelKey::ChannelPubKey(party))
    }

    // ── Lifecycle ────────────────────────────────────────────────────────

    /// Open a channel, pulling each party's deposit into escrow.
    ///
    /// Both parties must authorize the same call — atomic bilateral
    /// funding, no window where only one side's money is locked. Both must
    /// also already have a registered channel key, since every subsequent
    /// state update is only meaningful once the chain knows how to verify
    /// their signatures.
    pub fn open_channel(
        env: Env,
        a: Address,
        b: Address,
        token: Address,
        deposit_a: i128,
        deposit_b: i128,
    ) -> Result<u64, ChannelsError> {
        // Checked before either require_auth call: requiring the same
        // address's authorization twice in one invocation traps at the host
        // level rather than composing, so a==b has to be rejected first.
        if a == b {
            return Err(ChannelsError::SelfChannel);
        }
        a.require_auth();
        b.require_auth();

        if deposit_a < 0 || deposit_b < 0 || deposit_a + deposit_b <= 0 {
            return Err(ChannelsError::InvalidDeposit);
        }
        if env
            .storage()
            .persistent()
            .get::<_, BytesN<32>>(&ChannelKey::ChannelPubKey(a.clone()))
            .is_none()
            || env
                .storage()
                .persistent()
                .get::<_, BytesN<32>>(&ChannelKey::ChannelPubKey(b.clone()))
                .is_none()
        {
            return Err(ChannelsError::ChannelKeyNotRegistered);
        }

        let token_client = token::Client::new(&env, &token);
        if deposit_a > 0 {
            token_client.transfer(&a, &env.current_contract_address(), &deposit_a);
        }
        if deposit_b > 0 {
            token_client.transfer(&b, &env.current_contract_address(), &deposit_b);
        }

        let channel_id = env.storage().instance().get(&NEXT_ID).unwrap_or(0u64) + 1;
        env.storage().instance().set(&NEXT_ID, &channel_id);

        let channel = Channel {
            id: channel_id,
            party_a: a.clone(),
            party_b: b.clone(),
            token,
            deposit_a,
            deposit_b,
            status: ChannelStatus::Open,
        };
        save_channel(&env, &channel);

        env.events().publish(
            (symbol_short!("OPENED"), a),
            (channel_id, b, deposit_a, deposit_b),
        );

        Ok(channel_id)
    }

    /// Close instantly with both signatures present. No dispute window: two
    /// fresh, mutually consistent signatures are the strongest evidence of
    /// intent the protocol has, so there is nothing left to wait out.
    ///
    /// Callable by anyone — the recipients and amounts are fully determined
    /// by `state`'s own dual signature, so the submitter has no discretion
    /// to abuse. This lets either party, or a disinterested relayer, submit
    /// a cooperative close on both parties' behalf.
    pub fn close_cooperative(
        env: Env,
        channel_id: u64,
        state: ChannelState,
    ) -> Result<(), ChannelsError> {
        let mut channel = load_channel(&env, channel_id)?;
        if channel.status == ChannelStatus::Closed {
            return Err(ChannelsError::ChannelNotOpen);
        }
        if state.channel_id != channel_id {
            return Err(ChannelsError::ChannelIdMismatch);
        }

        let pubkey_a = registered_key(&env, &channel.party_a);
        let pubkey_b = registered_key(&env, &channel.party_b);
        verify_dual_signature(&env, &state, &pubkey_a, &pubkey_b);
        require_conserved(&channel, state.balance_a, state.balance_b)?;

        pay(
            &env,
            &channel.token,
            &channel.party_a,
            state.balance_a as i128,
        );
        pay(
            &env,
            &channel.token,
            &channel.party_b,
            state.balance_b as i128,
        );

        channel.status = ChannelStatus::Closed;
        save_channel(&env, &channel);
        env.storage()
            .persistent()
            .remove(&ChannelKey::PendingClose(channel_id));

        env.events().publish(
            (symbol_short!("COOP_CLS"), channel.party_a.clone()),
            (channel_id, state.balance_a, state.balance_b),
        );

        Ok(())
    }

    /// Start a unilateral close: `closer` submits a state and a dispute
    /// window begins. Anyone who holds a validly higher-versioned state has
    /// until `dispute_deadline` to supersede it via `dispute`, or to prove
    /// it was revoked via `punish`.
    pub fn close_unilateral(
        env: Env,
        closer: Address,
        channel_id: u64,
        state: ChannelState,
    ) -> Result<u64, ChannelsError> {
        closer.require_auth();

        let mut channel = load_channel(&env, channel_id)?;
        require_party(&channel, &closer)?;
        if channel.status != ChannelStatus::Open {
            return Err(ChannelsError::ChannelNotOpen);
        }
        if state.channel_id != channel_id {
            return Err(ChannelsError::ChannelIdMismatch);
        }

        let pubkey_a = registered_key(&env, &channel.party_a);
        let pubkey_b = registered_key(&env, &channel.party_b);
        verify_dual_signature(&env, &state, &pubkey_a, &pubkey_b);
        require_conserved(&channel, state.balance_a, state.balance_b)?;

        let dispute_deadline = env.ledger().timestamp() + DISPUTE_WINDOW_SECS;
        let pending = PendingClose {
            closer: closer.clone(),
            dispute_deadline,
            version: state.version,
            balance_a: state.balance_a,
            balance_b: state.balance_b,
            revocation_commit_a: state.revocation_commit_a.clone(),
            revocation_commit_b: state.revocation_commit_b.clone(),
        };
        save_pending(&env, channel_id, &pending);

        channel.status = ChannelStatus::Closing;
        save_channel(&env, &channel);

        // The exact event ChannelMonitor.js watches for to dispatch to a
        // Watchtower — see that module for the offline-party recovery path.
        env.events().publish(
            (Symbol::new(&env, "UNILATERAL_CLOSE"), closer),
            (channel_id, state.version, dispute_deadline),
        );

        Ok(dispute_deadline)
    }

    /// Supersede the pending close with a correctly signed, strictly higher
    /// version. Restarts nothing — the original `dispute_deadline` stands —
    /// so a dispute cannot be used to buy the closer more time.
    pub fn dispute(
        env: Env,
        challenger: Address,
        channel_id: u64,
        later_state: ChannelState,
    ) -> Result<(), ChannelsError> {
        let channel = load_channel(&env, channel_id)?;
        require_party(&channel, &challenger)?;
        if channel.status != ChannelStatus::Closing {
            return Err(ChannelsError::ChannelNotClosing);
        }
        if later_state.channel_id != channel_id {
            return Err(ChannelsError::ChannelIdMismatch);
        }

        let pubkey_a = registered_key(&env, &channel.party_a);
        let pubkey_b = registered_key(&env, &channel.party_b);
        verify_dual_signature(&env, &later_state, &pubkey_a, &pubkey_b);
        require_conserved(&channel, later_state.balance_a, later_state.balance_b)?;

        let mut pending = load_pending(&env, channel_id);
        if later_state.version <= pending.version {
            return Err(ChannelsError::VersionNotHigher);
        }

        pending.version = later_state.version;
        pending.balance_a = later_state.balance_a;
        pending.balance_b = later_state.balance_b;
        pending.revocation_commit_a = later_state.revocation_commit_a.clone();
        pending.revocation_commit_b = later_state.revocation_commit_b.clone();
        // dispute_deadline is deliberately left untouched.
        save_pending(&env, channel_id, &pending);

        env.events().publish(
            (symbol_short!("DISPUTED"), challenger),
            (channel_id, pending.version),
        );

        Ok(())
    }

    /// Prove the pending close rests on a version both parties already
    /// moved past, using nothing but a revealed revocation secret. Pays the
    /// entire channel balance to `challenger` as a deterrent — strictly
    /// worse for the closer than closing honestly ever could be.
    ///
    /// `challenger` must be the channel's *other* party — the one who did
    /// not initiate the disputed close — so an onlooker who merely observes
    /// a leaked secret cannot name themselves as the payout recipient. A
    /// Watchtower calls this with the honest party's address, not its own.
    pub fn punish(
        env: Env,
        challenger: Address,
        channel_id: u64,
        revocation_secret: BytesN<32>,
    ) -> Result<i128, ChannelsError> {
        let mut channel = load_channel(&env, channel_id)?;
        if channel.status != ChannelStatus::Closing {
            return Err(ChannelsError::ChannelNotClosing);
        }

        let pending = load_pending(&env, channel_id);
        require_party(&channel, &challenger)?;
        if challenger == pending.closer {
            return Err(ChannelsError::NotTheHonestParty);
        }

        let secret_bytes = Bytes::from_array(&env, &revocation_secret.to_array());
        let secret_hash: BytesN<32> = env.crypto().sha256(&secret_bytes).into();
        if secret_hash != pending.revocation_commit_a && secret_hash != pending.revocation_commit_b
        {
            return Err(ChannelsError::InvalidRevocationSecret);
        }

        let payout = channel.deposit_a + channel.deposit_b;
        pay(&env, &channel.token, &challenger, payout);

        channel.status = ChannelStatus::Closed;
        save_channel(&env, &channel);
        env.storage()
            .persistent()
            .remove(&ChannelKey::PendingClose(channel_id));

        env.events().publish(
            (symbol_short!("PUNISHED"), challenger),
            (channel_id, payout),
        );

        Ok(payout)
    }

    /// Finalize a unilateral close once its dispute window has elapsed
    /// uncontested. Callable by anyone — the payout is fully determined by
    /// the pending state, so there is no discretion to abuse, and requiring
    /// a specific caller would only create a liveness risk if that party
    /// were unreachable.
    pub fn force_close(env: Env, channel_id: u64) -> Result<(), ChannelsError> {
        let mut channel = load_channel(&env, channel_id)?;
        if channel.status != ChannelStatus::Closing {
            return Err(ChannelsError::ChannelNotClosing);
        }

        let pending = load_pending(&env, channel_id);
        if env.ledger().timestamp() < pending.dispute_deadline {
            return Err(ChannelsError::DisputeWindowOpen);
        }

        pay(
            &env,
            &channel.token,
            &channel.party_a,
            pending.balance_a as i128,
        );
        pay(
            &env,
            &channel.token,
            &channel.party_b,
            pending.balance_b as i128,
        );

        channel.status = ChannelStatus::Closed;
        save_channel(&env, &channel);
        env.storage()
            .persistent()
            .remove(&ChannelKey::PendingClose(channel_id));

        env.events().publish(
            (symbol_short!("FRC_CLS"), channel_id),
            (pending.balance_a, pending.balance_b),
        );

        Ok(())
    }

    // ── Views ────────────────────────────────────────────────────────────

    pub fn get_channel(env: Env, channel_id: u64) -> Option<Channel> {
        env.storage()
            .persistent()
            .get(&ChannelKey::Channel(channel_id))
    }

    pub fn get_pending_close(env: Env, channel_id: u64) -> Option<PendingClose> {
        env.storage()
            .persistent()
            .get(&ChannelKey::PendingClose(channel_id))
    }

    pub fn channel_count(env: Env) -> u64 {
        env.storage().instance().get(&NEXT_ID).unwrap_or(0u64)
    }

    /// The commitment hash a Watchtower blob for `state` would be keyed on —
    /// exposed so an off-chain service can confirm it derives the same value
    /// the contract would.
    pub fn state_commitment_hash(env: Env, state: ChannelState) -> BytesN<32> {
        state_commitment_hash(&env, &state)
    }
}

#[cfg(test)]
mod test;
