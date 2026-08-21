#![no_std]

//! Micropayments streaming contract for Intelligence Rail.
//!
//! Enables agents to open payment streams to pay for intelligence asset usage
//! continuously (per-second or per-call billing), with deposit/withdrawal and
//! automatic settlement.

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Env, Map, Symbol, Vec,
};

const STREAMS: Symbol = symbol_short!("STREAMS");
const STREAM_CNT: Symbol = symbol_short!("S_CNT");
const NONCE_REGISTRY: Symbol = symbol_short!("NONCE_REG");

/// State of a payment stream
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StreamStatus {
    Active,
    Paused,
    Completed,
    Cancelled,
}

/// Settlement status for a stream
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SettlementStatus {
    pub last_settled_amount: i128,
    pub ledger_sequence: u32,
}

/// Settlement errors
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SettlementError {
    StaleNonce,
    PartialBatchFailure,
}

const USAGE_STREAMS: Symbol = symbol_short!("U_STREAMS");
const USAGE_STREAM_CNT: Symbol = symbol_short!("US_CNT");

/// A usage-based payment stream from a sender to a recipient
#[contracttype]
#[derive(Clone, Debug)]
pub struct UsageStream {
    pub id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub token: Address,
    pub deposit: i128,
    pub accrued: i128,
    pub settled: i128,
    pub status: StreamStatus,
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
    /// Open a usage-based stream.
    pub fn open(
        env: Env,
        sender: Address,
        recipient: Address,
        token: Address,
        deposit: i128,
    ) -> u64 {
        sender.require_auth();
        assert!(deposit > 0, "deposit must be positive");

        // Pull deposit from sender
        let token_client = soroban_sdk::token::Client::new(&env, &token);
        token_client.transfer(&sender, &env.current_contract_address(), &deposit);

        let count: u64 = env.storage().instance().get(&USAGE_STREAM_CNT).unwrap_or(0u64);
        let stream_id = count + 1;

        let stream = UsageStream {
            id: stream_id,
            sender: sender.clone(),
            recipient: recipient.clone(),
            token,
            deposit,
            accrued: 0,
            settled: 0,
            status: StreamStatus::Active,
        };

        let mut streams: Map<u64, UsageStream> = env
            .storage()
            .persistent()
            .get(&USAGE_STREAMS)
            .unwrap_or(Map::new(&env));

        streams.set(stream_id, stream);
        env.storage().persistent().set(&USAGE_STREAMS, &streams);
        env.storage().instance().set(&USAGE_STREAM_CNT, &stream_id);

        env.events()
            .publish((symbol_short!("U_OPENED"), sender), (stream_id, deposit));

        stream_id
    }

    /// Accrue usage on a usage-based stream.
    pub fn increment(env: Env, sender: Address, stream_id: u64, amount: i128) {
        sender.require_auth();
        assert!(amount > 0, "amount must be positive");

        let mut streams: Map<u64, UsageStream> = env
            .storage()
            .persistent()
            .get(&USAGE_STREAMS)
            .unwrap_or(Map::new(&env));

        let mut stream = streams.get(stream_id).unwrap();
        assert!(stream.sender == sender, "not the stream sender");
        assert!(stream.status == StreamStatus::Active, "stream not active");

        stream.accrued += amount;
        assert!(stream.accrued <= stream.deposit, "accrued exceeds deposit");

        streams.set(stream_id, stream);
        env.storage().persistent().set(&USAGE_STREAMS, &streams);

        env.events()
            .publish((symbol_short!("U_INCR"), sender), (stream_id, amount));
    }

    /// Settle a usage-based stream.
    pub fn settle(env: Env, recipient: Address, stream_id: u64) -> i128 {
        recipient.require_auth();

        let mut streams: Map<u64, UsageStream> = env
            .storage()
            .persistent()
            .get(&USAGE_STREAMS)
            .unwrap_or(Map::new(&env));

        let mut stream = streams.get(stream_id).unwrap();
        assert!(stream.recipient == recipient, "not the stream recipient");

        let claimable = stream.accrued - stream.settled;
        if claimable <= 0 {
            return 0;
        }

        let token_client = soroban_sdk::token::Client::new(&env, &stream.token);
        token_client.transfer(&env.current_contract_address(), &recipient, &claimable);

        stream.settled += claimable;

        // Auto-complete if deposit exhausted
        if stream.settled >= stream.deposit {
            stream.status = StreamStatus::Completed;
        }

        streams.set(stream_id, stream.clone());
        env.storage().persistent().set(&USAGE_STREAMS, &streams);

        env.events()
            .publish((symbol_short!("U_SETTLED"), recipient), (stream_id, claimable));

        claimable
    }

    pub fn get_usage_stream(env: Env, stream_id: u64) -> Option<UsageStream> {
        let streams: Map<u64, UsageStream> = env
            .storage()
            .persistent()
            .get(&USAGE_STREAMS)
            .unwrap_or(Map::new(&env));
        streams.get(stream_id)
    }

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
        if amount <= 0 {
            return 0;
        }

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

    /// Settle multiple streams for a recipient in a single transaction.
    /// Includes idempotency guard via batch_nonce to prevent double-payment.
    pub fn batch_settle(env: Env, recipient: Address, stream_ids: Vec<u64>, batch_nonce: u64) -> Map<u64, i128> {
        recipient.require_auth();

        // Check if this nonce was already used
        let mut nonce_registry: Map<Address, Map<u64, Map<u64, i128>>> = env
            .storage()
            .persistent()
            .get(&NONCE_REGISTRY)
            .unwrap_or(Map::new(&env));

        if let Some(recipient_nonces) = nonce_registry.get(recipient.clone()) {
            if let Some(cached_result) = recipient_nonces.get(batch_nonce) {
                // Nonce already used - return cached result (idempotent replay)
                return cached_result;
            }
        }

        let mut streams: Map<u64, PaymentStream> = env
            .storage()
            .persistent()
            .get(&STREAMS)
            .unwrap_or(Map::new(&env));

        let mut settled_amounts: Map<u64, i128> = Map::new(&env);
        let now = env.ledger().timestamp();

        for id in stream_ids.iter() {
            if let Some(mut stream) = streams.get(id) {
                assert!(stream.recipient == recipient, "not the stream recipient");
                let amount = stream.claimable(now);
                if amount > 0 {
                    let token_client = soroban_sdk::token::Client::new(&env, &stream.token);
                    token_client.transfer(&env.current_contract_address(), &recipient, &amount);

                    stream.withdrawn += amount;
                    stream.last_settled = now;

                    // Auto-complete if deposit exhausted or past end_time
                    if stream.withdrawn >= stream.deposit || now >= stream.end_time {
                        stream.status = StreamStatus::Completed;
                    }

                    streams.set(id, stream.clone());
                    settled_amounts.set(id, amount);

                    env.events().publish(
                        (symbol_short!("WITHDRAWN"), recipient.clone()),
                        (id, amount),
                    );
                } else {
                    settled_amounts.set(id, 0);
                }
            } else {
                settled_amounts.set(id, 0);
            }
        }

        env.storage().persistent().set(&STREAMS, &streams);

        // Cache the result for this nonce
        let mut recipient_nonces = nonce_registry.get(recipient.clone()).unwrap_or(Map::new(&env));
        recipient_nonces.set(batch_nonce, settled_amounts.clone());
        nonce_registry.set(recipient, recipient_nonces);
        env.storage().persistent().set(&NONCE_REGISTRY, &nonce_registry);

        settled_amounts
    }

    /// View helper to check the claimable balance across multiple streams.
    pub fn get_claimable_batch(env: Env, stream_ids: Vec<u64>) -> Map<u64, i128> {
        let streams: Map<u64, PaymentStream> = env
            .storage()
            .persistent()
            .get(&STREAMS)
            .unwrap_or(Map::new(&env));

        let mut result: Map<u64, i128> = Map::new(&env);
        let now = env.ledger().timestamp();

        for id in stream_ids.iter() {
            match streams.get(id) {
                Some(s) => {
                    result.set(id, s.claimable(now));
                }
                None => {
                    result.set(id, 0);
                }
            }
        }
        result
    }

    /// Get settlement status for multiple streams.
    /// Returns per-stream last-settled-amount and ledger sequence for reconciliation.
    pub fn get_settlement_status(env: Env, stream_ids: Vec<u64>) -> Map<u64, SettlementStatus> {
        let streams: Map<u64, PaymentStream> = env
            .storage()
            .persistent()
            .get(&STREAMS)
            .unwrap_or(Map::new(&env));

        let mut result: Map<u64, SettlementStatus> = Map::new(&env);
        let ledger_seq = env.ledger().sequence();

        for id in stream_ids.iter() {
            match streams.get(id) {
                Some(s) => {
                    let status = SettlementStatus {
                        last_settled_amount: s.withdrawn,
                        ledger_sequence: ledger_seq,
                    };
                    result.set(id, status);
                }
                None => {
                    // Return zero status for non-existent streams
                    let status = SettlementStatus {
                        last_settled_amount: 0,
                        ledger_sequence: ledger_seq,
                    };
                    result.set(id, status);
                }
            }
        }
        result
    }
}

#[cfg(test)]
mod test;
