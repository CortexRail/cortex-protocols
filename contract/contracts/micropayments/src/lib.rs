#![no_std]

//! Micropayments streaming contract for Intelligence Rail.
//!
//! Enables agents to open payment streams to pay for intelligence asset usage
//! continuously (per-second or per-call billing), with deposit/withdrawal and
//! automatic settlement.

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env, Map, Symbol};

const STREAMS: Symbol = symbol_short!("STREAMS");
const STREAM_CNT: Symbol = symbol_short!("S_CNT");

/// State of a payment stream
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StreamStatus {
    Active,
    Paused,
    Completed,
    Cancelled,
}

/// A payment stream from a sender to a recipient
#[contracttype]
#[derive(Clone, Debug)]
pub struct PaymentStream {
    pub id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub token: Address,
    /// Total deposited into the stream
    pub deposit: i128,
    /// Rate in stroops per ledger-second
    pub rate_per_second: i128,
    pub start_time: u64,
    pub end_time: u64,
    /// Last settlement timestamp
    pub last_settled: u64,
    /// Amount already withdrawn by recipient
    pub withdrawn: i128,
    pub status: StreamStatus,
}

impl PaymentStream {
    /// Compute how much the recipient can withdraw right now.
    pub fn claimable(&self, now: u64) -> i128 {
        if self.status != StreamStatus::Active {
            return 0;
        }
        let elapsed = now.saturating_sub(self.last_settled) as i128;
        let earned = elapsed * self.rate_per_second;
        let remaining = self.deposit - self.withdrawn;
        if earned > remaining {
            remaining
        } else {
            earned
        }
    }
}

#[contract]
pub struct MicropaymentsContract;

#[contractimpl]
impl MicropaymentsContract {
    /// Open a new payment stream.
    pub fn open_stream(
        env: Env,
        sender: Address,
        recipient: Address,
        token: Address,
        deposit: i128,
        rate_per_second: i128,
        duration_secs: u64,
    ) -> u64 {
        sender.require_auth();
        assert!(deposit > 0, "deposit must be positive");
        assert!(rate_per_second > 0, "rate must be positive");

        // Pull deposit from sender
        let token_client = soroban_sdk::token::Client::new(&env, &token);
        token_client.transfer(&sender, &env.current_contract_address(), &deposit);

        let count: u64 = env.storage().instance().get(&STREAM_CNT).unwrap_or(0u64);
        let stream_id = count + 1;
        let now = env.ledger().timestamp();

        let stream = PaymentStream {
            id: stream_id,
            sender: sender.clone(),
            recipient: recipient.clone(),
            token,
            deposit,
            rate_per_second,
            start_time: now,
            end_time: now + duration_secs,
            last_settled: now,
            withdrawn: 0,
            status: StreamStatus::Active,
        };

        let mut streams: Map<u64, PaymentStream> = env
            .storage()
            .persistent()
            .get(&STREAMS)
            .unwrap_or(Map::new(&env));

        streams.set(stream_id, stream);
        env.storage().persistent().set(&STREAMS, &streams);
        env.storage().instance().set(&STREAM_CNT, &stream_id);

        env.events()
            .publish((symbol_short!("OPENED"), sender), (stream_id, deposit));

        stream_id
    }

    /// Recipient withdraws accrued funds.
    pub fn withdraw(env: Env, recipient: Address, stream_id: u64) -> i128 {
        recipient.require_auth();

        let mut streams: Map<u64, PaymentStream> = env
            .storage()
            .persistent()
            .get(&STREAMS)
            .unwrap_or(Map::new(&env));

        let mut stream = streams.get(stream_id).unwrap();
        assert!(stream.recipient == recipient, "not the stream recipient");

        let now = env.ledger().timestamp();
        let amount = stream.claimable(now);
        assert!(amount > 0, "nothing to withdraw");

        let token_client = soroban_sdk::token::Client::new(&env, &stream.token);
        token_client.transfer(&env.current_contract_address(), &recipient, &amount);

        stream.withdrawn += amount;
        stream.last_settled = now;

        // Auto-complete if deposit exhausted or past end_time
        if stream.withdrawn >= stream.deposit || now >= stream.end_time {
            stream.status = StreamStatus::Completed;
        }

        streams.set(stream_id, stream.clone());
        env.storage().persistent().set(&STREAMS, &streams);

        env.events()
            .publish((symbol_short!("WITHDRAWN"), recipient), (stream_id, amount));

        amount
    }

    /// Sender cancels a stream; unearned funds are refunded.
    pub fn cancel_stream(env: Env, sender: Address, stream_id: u64) {
        sender.require_auth();

        let mut streams: Map<u64, PaymentStream> = env
            .storage()
            .persistent()
            .get(&STREAMS)
            .unwrap_or(Map::new(&env));

        let mut stream = streams.get(stream_id).unwrap();
        assert!(stream.sender == sender, "not the stream sender");
        assert!(
            stream.status == StreamStatus::Active || stream.status == StreamStatus::Paused,
            "stream already closed"
        );

        let now = env.ledger().timestamp();
        let earned = stream.claimable(now);
        let refund = stream.deposit - stream.withdrawn - earned;

        let token_client = soroban_sdk::token::Client::new(&env, &stream.token);

        // Pay recipient their earned portion
        if earned > 0 {
            token_client.transfer(&env.current_contract_address(), &stream.recipient, &earned);
            stream.withdrawn += earned;
        }

        // Refund sender remainder
        if refund > 0 {
            token_client.transfer(&env.current_contract_address(), &sender, &refund);
        }

        stream.status = StreamStatus::Cancelled;
        streams.set(stream_id, stream);
        env.storage().persistent().set(&STREAMS, &streams);

        env.events()
            .publish((symbol_short!("CANCELLED"), sender), stream_id);
    }

    /// Pause an active stream (sender only).
    pub fn pause_stream(env: Env, sender: Address, stream_id: u64) {
        sender.require_auth();

        let mut streams: Map<u64, PaymentStream> = env
            .storage()
            .persistent()
            .get(&STREAMS)
            .unwrap_or(Map::new(&env));

        let mut stream = streams.get(stream_id).unwrap();
        assert!(stream.sender == sender, "not the stream sender");
        assert!(stream.status == StreamStatus::Active, "stream not active");

        stream.status = StreamStatus::Paused;
        streams.set(stream_id, stream);
        env.storage().persistent().set(&STREAMS, &streams);
    }

    /// Resume a paused stream.
    pub fn resume_stream(env: Env, sender: Address, stream_id: u64) {
        sender.require_auth();

        let mut streams: Map<u64, PaymentStream> = env
            .storage()
            .persistent()
            .get(&STREAMS)
            .unwrap_or(Map::new(&env));

        let mut stream = streams.get(stream_id).unwrap();
        assert!(stream.sender == sender, "not the stream sender");
        assert!(stream.status == StreamStatus::Paused, "stream not paused");

        stream.status = StreamStatus::Active;
        stream.last_settled = env.ledger().timestamp();
        streams.set(stream_id, stream);
        env.storage().persistent().set(&STREAMS, &streams);
    }

    // ── Queries ───────────────────────────────────────────────────────────

    pub fn get_stream(env: Env, stream_id: u64) -> Option<PaymentStream> {
        let streams: Map<u64, PaymentStream> = env
            .storage()
            .persistent()
            .get(&STREAMS)
            .unwrap_or(Map::new(&env));
        streams.get(stream_id)
    }

    pub fn claimable_amount(env: Env, stream_id: u64) -> i128 {
        let streams: Map<u64, PaymentStream> = env
            .storage()
            .persistent()
            .get(&STREAMS)
            .unwrap_or(Map::new(&env));
        match streams.get(stream_id) {
            Some(s) => s.claimable(env.ledger().timestamp()),
            None => 0,
        }
    }

    pub fn stream_count(env: Env) -> u64 {
        env.storage().instance().get(&STREAM_CNT).unwrap_or(0u64)
    }
}

// Streams auto-complete when deposit is fully withdrawn or end_time is reached.
