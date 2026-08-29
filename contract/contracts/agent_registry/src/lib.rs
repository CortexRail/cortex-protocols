#![no_std]

//! Agent Registry contract for Intelligence Rail.
//!
//! Stores on-chain identities for autonomous agents, their capability
//! declarations, reputation scores, and wallet addresses.

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, token, Address, BytesN, Env, Map, String,
    Symbol, Vec,
};

const AGENTS: Symbol = symbol_short!("AGENTS");
const AGENT_CNT: Symbol = symbol_short!("AG_CNT");
const REP: Symbol = symbol_short!("REP");
/// Map<Address, StakeRecord> — collateral locked by each agent address.
const STAKES: Symbol = symbol_short!("STAKES");
/// Map<u64, Dispute>
const DISPUTES: Symbol = symbol_short!("DISPUTES");
/// u64 — monotonic dispute id counter.
const DISP_CNT: Symbol = symbol_short!("DISP_CNT");
/// Map<(u64, Address), bool> — one recorded vote per (dispute, voter).
const VOTES: Symbol = symbol_short!("VOTES");
/// Map<(Address, Address), u32> — how often two addresses have transacted.
const INTERACT: Symbol = symbol_short!("INTERACT");
/// Map<u64, u64> — ledger timestamp a reputation score was last settled at.
const REP_TS: Symbol = symbol_short!("REP_TS");
/// Map<Address, Vec<u64>> — agent ids owned by an address.
const OWNED: Symbol = symbol_short!("OWNED");
/// RepConfig — economic parameters.
const CONFIG: Symbol = symbol_short!("CONFIG");
/// Address — the account allowed to change CONFIG.
const ADMIN: Symbol = symbol_short!("ADMIN");

/// Basis-point denominator (100.00%).
const BPS_DENOM: u32 = 10_000;
/// Upper bound on decay iterations, so a long-dormant agent cannot make a read
/// unboundedly expensive. Two years of daily decay already floors any score.
const MAX_DECAY_PERIODS: u64 = 730;

// Defaults applied until `configure` is called.
const DEFAULT_SLASH_BPS: u32 = 2_000; // 20% of the stake on a guilty verdict
const DEFAULT_VOTING_WINDOW: u64 = 259_200; // 3 days
const DEFAULT_QUORUM_WEIGHT: i128 = 1_000;
const DEFAULT_DECAY_BPS: u32 = 9_900; // 99% of the score survives each period
const DEFAULT_DECAY_PERIOD: u64 = 86_400; // 1 day

/// Agent capability flags
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Capability {
    TextGeneration,
    CodeGeneration,
    Reasoning,
    VisionUnderstanding,
    AudioProcessing,
    DataAnalysis,
    WebResearch,
    ActionExecution,
}

/// Registered autonomous agent
#[contracttype]
#[derive(Clone, Debug)]
pub struct Agent {
    pub id: u64,
    pub owner: Address,
    pub name: String,
    pub description: String,
    pub capabilities: Vec<Capability>,
    /// Reputation score (0–10_000 basis points)
    pub reputation: u32,
    pub total_transactions: u64,
    pub is_active: bool,
    pub registered_at: u64,
}

/// A reputation vote cast by another agent or user
#[contracttype]
#[derive(Clone, Debug)]
pub struct ReputationVote {
    pub voter: Address,
    pub agent_id: u64,
    /// Score from 0 to 100
    pub score: u32,
    pub voted_at: u64,
}

/// Collateral an agent address has locked against its reputation.
#[contracttype]
#[derive(Clone, Debug)]
pub struct StakeRecord {
    pub agent: Address,
    /// Token the collateral is denominated in.
    pub token: Address,
    /// Currently locked amount.
    pub amount: i128,
    /// Cumulative amount lost to slashing.
    pub slashed: i128,
    pub staked_at: u64,
}

/// Lifecycle of a dispute.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DisputeStatus {
    Open,
    Resolved,
}

/// Verdict returned by `resolve_dispute`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DisputeOutcome {
    /// Voting is still open — no verdict yet.
    Pending,
    /// Weighted majority voted against the respondent — stake was slashed.
    Guilty,
    /// Weighted majority sided with the respondent.
    NotGuilty,
    /// Not enough voting weight took part; nothing is slashed.
    QuorumFailed,
}

/// A dispute raised against a staked agent.
#[contracttype]
#[derive(Clone, Debug)]
pub struct Dispute {
    pub id: u64,
    pub complainant: Address,
    pub respondent: Address,
    /// Hash of the evidence bundle held off-chain.
    pub evidence_hash: BytesN<32>,
    pub opened_at: u64,
    /// Voting closes at this ledger timestamp.
    pub closes_at: u64,
    /// Weight voting that the respondent is at fault.
    pub weight_for: i128,
    /// Weight voting in the respondent's favour.
    pub weight_against: i128,
    pub vote_count: u32,
    pub status: DisputeStatus,
    pub outcome: DisputeOutcome,
    pub slashed_amount: i128,
}

/// Economic parameters of the reputation system.
#[contracttype]
#[derive(Clone, Debug)]
pub struct RepConfig {
    /// Share of the respondent's stake slashed on a guilty verdict.
    pub slash_bps: u32,
    /// Seconds a dispute stays open for voting.
    pub voting_window: u64,
    /// Minimum total weight required for a verdict to count.
    pub quorum_weight: i128,
    /// Share of a score that survives one decay period.
    pub decay_bps: u32,
    /// Length of one decay period, in seconds.
    pub decay_period: u64,
}

impl RepConfig {
    fn default_config() -> RepConfig {
        RepConfig {
            slash_bps: DEFAULT_SLASH_BPS,
            voting_window: DEFAULT_VOTING_WINDOW,
            quorum_weight: DEFAULT_QUORUM_WEIGHT,
            decay_bps: DEFAULT_DECAY_BPS,
            decay_period: DEFAULT_DECAY_PERIOD,
        }
    }
}

#[contract]
pub struct AgentRegistryContract;

#[contractimpl]
impl AgentRegistryContract {
    /// Register a new agent identity.
    pub fn register_agent(
        env: Env,
        owner: Address,
        name: String,
        description: String,
        capabilities: Vec<Capability>,
    ) -> u64 {
        owner.require_auth();

        let count: u64 = env.storage().instance().get(&AGENT_CNT).unwrap_or(0u64);
        let agent_id = count + 1;

        let agent = Agent {
            id: agent_id,
            owner: owner.clone(),
            name,
            description,
            capabilities,
            reputation: 5_000, // neutral starting rep (50.00%)
            total_transactions: 0,
            is_active: true,
            registered_at: env.ledger().timestamp(),
        };

        let mut agents: Map<u64, Agent> = env
            .storage()
            .persistent()
            .get(&AGENTS)
            .unwrap_or(Map::new(&env));

        agents.set(agent_id, agent);
        env.storage().persistent().set(&AGENTS, &agents);
        env.storage().instance().set(&AGENT_CNT, &agent_id);

        // Track ownership so a slashing verdict can reach every agent an
        // address is accountable for, and seed the decay clock.
        let mut owned: Map<Address, Vec<u64>> = read_map(&env, &OWNED);
        let mut ids = owned.get(owner.clone()).unwrap_or(Vec::new(&env));
        ids.push_back(agent_id);
        owned.set(owner.clone(), ids);
        env.storage().persistent().set(&OWNED, &owned);

        let mut rep_ts: Map<u64, u64> = read_map(&env, &REP_TS);
        rep_ts.set(agent_id, env.ledger().timestamp());
        env.storage().persistent().set(&REP_TS, &rep_ts);

        env.events()
            .publish((Symbol::new(&env, "REGISTERED"), owner), agent_id);

        agent_id
    }

    /// Update agent capabilities.
    pub fn update_capabilities(
        env: Env,
        owner: Address,
        agent_id: u64,
        capabilities: Vec<Capability>,
    ) {
        owner.require_auth();

        let mut agents: Map<u64, Agent> = env
            .storage()
            .persistent()
            .get(&AGENTS)
            .unwrap_or(Map::new(&env));

        let mut agent = agents.get(agent_id).unwrap();
        assert!(agent.owner == owner, "not the agent owner");

        agent.capabilities = capabilities;
        agents.set(agent_id, agent);
        env.storage().persistent().set(&AGENTS, &agents);
    }

    /// Submit a reputation vote for an agent.
    /// Caller must be different from the agent owner.
    pub fn vote_reputation(env: Env, voter: Address, agent_id: u64, score: u32) {
        voter.require_auth();
        assert!(score <= 100, "score must be 0-100");

        let mut agents: Map<u64, Agent> = env
            .storage()
            .persistent()
            .get(&AGENTS)
            .unwrap_or(Map::new(&env));

        let mut agent = agents.get(agent_id).unwrap();
        assert!(agent.owner != voter, "cannot vote on own agent");

        let vote_key = (REP, voter.clone(), agent_id);
        let already_voted: Option<ReputationVote> = env.storage().persistent().get(&vote_key);
        assert!(already_voted.is_none(), "voter has already voted on this agent");

        // Fold elapsed decay into the stored score first, so a vote is applied
        // to what the score is worth *now* rather than to a stale snapshot.
        agent.reputation = settle_stored_reputation(&env, agent_id, agent.reputation);

        // Simple rolling average update (weight = 10% of current)
        let new_score_bp = score * 100; // convert to basis points
        agent.reputation = (agent.reputation * 9 + new_score_bp) / 10;

        agents.set(agent_id, agent);
        env.storage().persistent().set(&AGENTS, &agents);

        let vote = ReputationVote {
            voter: voter.clone(),
            agent_id,
            score,
            voted_at: env.ledger().timestamp(),
        };

        env.storage().persistent().set(&vote_key, &vote);

        env.events()
            .publish((symbol_short!("VOTED"), voter), (agent_id, score));
    }

    /// Record a completed transaction (callable by marketplace contract).
    pub fn record_transaction(env: Env, caller: Address, agent_id: u64) {
        caller.require_auth();

        let mut agents: Map<u64, Agent> = env
            .storage()
            .persistent()
            .get(&AGENTS)
            .unwrap_or(Map::new(&env));

        let mut agent = agents.get(agent_id).unwrap();
        agent.total_transactions += 1;
        agents.set(agent_id, agent);
        env.storage().persistent().set(&AGENTS, &agents);
    }

    /// Deactivate an agent. Deactivated agents remain on-chain but are excluded from discovery.
    pub fn deactivate_agent(env: Env, owner: Address, agent_id: u64) {
        owner.require_auth();

        let mut agents: Map<u64, Agent> = env
            .storage()
            .persistent()
            .get(&AGENTS)
            .unwrap_or(Map::new(&env));

        let mut agent = agents.get(agent_id).unwrap();
        assert!(agent.owner == owner, "not the agent owner");
        agent.is_active = false;
        agents.set(agent_id, agent);
        env.storage().persistent().set(&AGENTS, &agents);
    }

    // ── Queries ───────────────────────────────────────────────────────────

    pub fn get_agent(env: Env, agent_id: u64) -> Option<Agent> {
        let agents: Map<u64, Agent> = env
            .storage()
            .persistent()
            .get(&AGENTS)
            .unwrap_or(Map::new(&env));
        agents.get(agent_id)
    }

    pub fn agent_count(env: Env) -> u64 {
        env.storage().instance().get(&AGENT_CNT).unwrap_or(0u64)
    }

    /// Current reputation with time-decay applied (computed lazily on read).
    pub fn get_reputation(env: Env, agent_id: u64) -> u32 {
        let agents: Map<u64, Agent> = read_map(&env, &AGENTS);
        match agents.get(agent_id) {
            Some(a) => decayed_reputation(&env, agent_id, a.reputation),
            None => 0,
        }
    }

    /// Reputation as stored, before decay is applied. Useful for reconciling
    /// the off-chain mirror against the on-chain base score.
    pub fn get_stored_reputation(env: Env, agent_id: u64) -> u32 {
        let agents: Map<u64, Agent> = read_map(&env, &AGENTS);
        match agents.get(agent_id) {
            Some(a) => a.reputation,
            None => 0,
        }
    }

    /// Timestamp the agent's score was last settled at (the decay clock).
    pub fn get_reputation_updated_at(env: Env, agent_id: u64) -> u64 {
        let rep_ts: Map<u64, u64> = read_map(&env, &REP_TS);
        rep_ts.get(agent_id).unwrap_or(0)
    }

    /// Write the decayed score back to storage and restart the decay clock.
    /// Anyone may call this; it can only ever lower a score to what a read
    /// already reports.
    pub fn settle_reputation(env: Env, agent_id: u64) -> u32 {
        let mut agents: Map<u64, Agent> = read_map(&env, &AGENTS);
        let mut agent = match agents.get(agent_id) {
            Some(a) => a,
            None => return 0,
        };

        agent.reputation = settle_stored_reputation(&env, agent_id, agent.reputation);
        let settled = agent.reputation;
        agents.set(agent_id, agent);
        env.storage().persistent().set(&AGENTS, &agents);
        settled
    }

    // ── Staking ───────────────────────────────────────────────────────────

    /// Lock collateral against an agent address's reputation.
    pub fn stake(env: Env, agent: Address, amount: i128, token: Address) {
        agent.require_auth();
        assert!(amount > 0, "stake amount must be positive");

        let mut stakes: Map<Address, StakeRecord> = read_map(&env, &STAKES);
        let record = match stakes.get(agent.clone()) {
            Some(existing) => {
                assert!(existing.token == token, "stake already held in another token");
                StakeRecord {
                    amount: existing.amount + amount,
                    ..existing
                }
            }
            None => StakeRecord {
                agent: agent.clone(),
                token: token.clone(),
                amount,
                slashed: 0,
                staked_at: env.ledger().timestamp(),
            },
        };

        token::Client::new(&env, &token).transfer(
            &agent,
            &env.current_contract_address(),
            &amount,
        );

        let total = record.amount;
        stakes.set(agent.clone(), record);
        env.storage().persistent().set(&STAKES, &stakes);

        env.events()
            .publish((Symbol::new(&env, "STAKED"), agent), (amount, total));
    }

    /// Release collateral. Blocked while a dispute against the agent is open,
    /// so a respondent cannot withdraw ahead of a verdict.
    pub fn unstake(env: Env, agent: Address, amount: i128) {
        agent.require_auth();
        assert!(amount > 0, "unstake amount must be positive");
        assert!(
            !has_open_dispute(&env, &agent),
            "cannot unstake while a dispute is open"
        );

        let mut stakes: Map<Address, StakeRecord> = read_map(&env, &STAKES);
        let mut record = stakes.get(agent.clone()).expect("no stake for agent");
        assert!(record.amount >= amount, "insufficient staked balance");

        record.amount -= amount;
        let token = record.token.clone();
        let remaining = record.amount;
        stakes.set(agent.clone(), record);
        env.storage().persistent().set(&STAKES, &stakes);

        token::Client::new(&env, &token).transfer(
            &env.current_contract_address(),
            &agent,
            &amount,
        );

        env.events()
            .publish((Symbol::new(&env, "UNSTAKED"), agent), (amount, remaining));
    }

    pub fn get_stake(env: Env, agent: Address) -> Option<StakeRecord> {
        let stakes: Map<Address, StakeRecord> = read_map(&env, &STAKES);
        stakes.get(agent)
    }

    // ── Interaction history (anti-brigading) ──────────────────────────────

    /// Record that two addresses have transacted. Callable by either party or
    /// by a settlement contract acting for them; a voter must have a recorded
    /// interaction with the respondent before their vote is accepted.
    pub fn record_interaction(env: Env, caller: Address, counterparty: Address) {
        caller.require_auth();
        assert!(caller != counterparty, "cannot interact with self");

        let mut interactions: Map<(Address, Address), u32> = read_map(&env, &INTERACT);
        let forward = (caller.clone(), counterparty.clone());
        let reverse = (counterparty.clone(), caller.clone());

        let count = interactions.get(forward.clone()).unwrap_or(0) + 1;
        interactions.set(forward, count);
        interactions.set(reverse, count);
        env.storage().persistent().set(&INTERACT, &interactions);
    }

    pub fn interaction_count(env: Env, a: Address, b: Address) -> u32 {
        let interactions: Map<(Address, Address), u32> = read_map(&env, &INTERACT);
        interactions.get((a, b)).unwrap_or(0)
    }

    // ── Disputes ──────────────────────────────────────────────────────────

    /// Open a dispute against a staked agent. Returns the dispute id.
    pub fn open_dispute(
        env: Env,
        complainant: Address,
        respondent: Address,
        evidence_hash: BytesN<32>,
    ) -> u64 {
        complainant.require_auth();
        assert!(complainant != respondent, "cannot dispute yourself");

        let stakes: Map<Address, StakeRecord> = read_map(&env, &STAKES);
        let stake = stakes.get(respondent.clone());
        assert!(
            stake.map(|s| s.amount).unwrap_or(0) > 0,
            "respondent has no stake to slash"
        );
        assert!(
            !has_open_dispute(&env, &respondent),
            "a dispute against this agent is already open"
        );

        let config = load_config(&env);
        let now = env.ledger().timestamp();
        let dispute_id: u64 = env.storage().instance().get(&DISP_CNT).unwrap_or(0) + 1;

        let closes_at = now + config.voting_window;
        let dispute = Dispute {
            id: dispute_id,
            complainant: complainant.clone(),
            respondent: respondent.clone(),
            evidence_hash,
            opened_at: now,
            closes_at,
            weight_for: 0,
            weight_against: 0,
            vote_count: 0,
            status: DisputeStatus::Open,
            outcome: DisputeOutcome::Pending,
            slashed_amount: 0,
        };

        let mut disputes: Map<u64, Dispute> = read_map(&env, &DISPUTES);
        disputes.set(dispute_id, dispute);
        env.storage().persistent().set(&DISPUTES, &disputes);
        env.storage().instance().set(&DISP_CNT, &dispute_id);

        env.events().publish(
            (
                Symbol::new(&env, "DISPUTE_OPENED"),
                complainant,
                respondent,
            ),
            (dispute_id, closes_at),
        );

        dispute_id
    }

    /// Vote on an open dispute. Weight is the voter's staked amount scaled by
    /// their own reputation, and a voter must have transacted with the
    /// respondent before — throwaway accounts carry no weight and are rejected.
    pub fn vote_dispute(env: Env, voter: Address, dispute_id: u64, in_favor: bool) {
        voter.require_auth();

        let mut disputes: Map<u64, Dispute> = read_map(&env, &DISPUTES);
        let mut dispute = disputes.get(dispute_id).expect("unknown dispute");
        assert!(dispute.status == DisputeStatus::Open, "dispute is resolved");
        assert!(
            env.ledger().timestamp() < dispute.closes_at,
            "voting window has closed"
        );
        assert!(voter != dispute.respondent, "respondent cannot vote");

        let mut votes: Map<(u64, Address), bool> = read_map(&env, &VOTES);
        assert!(
            votes.get((dispute_id, voter.clone())).is_none(),
            "voter has already voted"
        );

        let interactions: Map<(Address, Address), u32> = read_map(&env, &INTERACT);
        assert!(
            interactions
                .get((voter.clone(), dispute.respondent.clone()))
                .unwrap_or(0)
                > 0,
            "voter has no interaction history with the respondent"
        );

        let weight = voting_weight(&env, &voter);
        assert!(weight > 0, "voter has no stake-weighted voting power");

        if in_favor {
            dispute.weight_for += weight;
        } else {
            dispute.weight_against += weight;
        }
        dispute.vote_count += 1;

        disputes.set(dispute_id, dispute);
        env.storage().persistent().set(&DISPUTES, &disputes);

        votes.set((dispute_id, voter.clone()), in_favor);
        env.storage().persistent().set(&VOTES, &votes);

        env.events().publish(
            (Symbol::new(&env, "DISPUTE_VOTED"), voter),
            (dispute_id, weight, in_favor),
        );
    }

    /// Tally an expired dispute. On a guilty verdict the respondent's stake is
    /// slashed by the configured percentage and every agent they own takes the
    /// same proportional reputation hit.
    pub fn resolve_dispute(env: Env, dispute_id: u64) -> DisputeOutcome {
        let mut disputes: Map<u64, Dispute> = read_map(&env, &DISPUTES);
        let mut dispute = disputes.get(dispute_id).expect("unknown dispute");
        assert!(dispute.status == DisputeStatus::Open, "dispute is resolved");
        assert!(
            env.ledger().timestamp() >= dispute.closes_at,
            "voting window is still open"
        );

        let config = load_config(&env);
        let total_weight = dispute.weight_for + dispute.weight_against;

        let outcome = if total_weight < config.quorum_weight {
            DisputeOutcome::QuorumFailed
        } else if dispute.weight_for > dispute.weight_against {
            DisputeOutcome::Guilty
        } else {
            DisputeOutcome::NotGuilty
        };

        if outcome == DisputeOutcome::Guilty {
            let slashed = slash_stake(&env, &dispute.respondent, config.slash_bps);
            dispute.slashed_amount = slashed;
            penalize_owner_reputation(&env, &dispute.respondent, config.slash_bps);

            env.events().publish(
                (Symbol::new(&env, "STAKE_SLASHED"), dispute.respondent.clone()),
                (dispute_id, slashed),
            );
        }

        dispute.status = DisputeStatus::Resolved;
        dispute.outcome = outcome.clone();
        let respondent = dispute.respondent.clone();
        let slashed_amount = dispute.slashed_amount;
        disputes.set(dispute_id, dispute);
        env.storage().persistent().set(&DISPUTES, &disputes);

        env.events().publish(
            (Symbol::new(&env, "DISPUTE_RESOLVED"), respondent),
            (dispute_id, outcome.clone(), slashed_amount),
        );

        outcome
    }

    pub fn get_dispute(env: Env, dispute_id: u64) -> Option<Dispute> {
        let disputes: Map<u64, Dispute> = read_map(&env, &DISPUTES);
        disputes.get(dispute_id)
    }

    pub fn dispute_count(env: Env) -> u64 {
        env.storage().instance().get(&DISP_CNT).unwrap_or(0)
    }

    pub fn get_vote(env: Env, dispute_id: u64, voter: Address) -> Option<bool> {
        let votes: Map<(u64, Address), bool> = read_map(&env, &VOTES);
        votes.get((dispute_id, voter))
    }

    /// Weight `voter` would carry in a dispute right now.
    pub fn get_voting_weight(env: Env, voter: Address) -> i128 {
        voting_weight(&env, &voter)
    }

    // ── Configuration ─────────────────────────────────────────────────────

    /// Set the economic parameters. The first caller claims the admin role;
    /// afterwards only that address may change them.
    pub fn configure(env: Env, admin: Address, config: RepConfig) {
        admin.require_auth();
        assert!(config.slash_bps <= BPS_DENOM, "slash_bps out of range");
        assert!(config.decay_bps <= BPS_DENOM, "decay_bps out of range");
        assert!(config.quorum_weight >= 0, "quorum_weight must not be negative");

        let stored: Option<Address> = env.storage().instance().get(&ADMIN);
        match stored {
            Some(existing) => assert!(existing == admin, "not the registry admin"),
            None => env.storage().instance().set(&ADMIN, &admin),
        }

        env.storage().instance().set(&CONFIG, &config);
    }

    pub fn get_config(env: Env) -> RepConfig {
        load_config(&env)
    }
}

// ── Internal helpers ──────────────────────────────────────────────────────

fn read_map<K, V>(env: &Env, key: &Symbol) -> Map<K, V>
where
    K: soroban_sdk::TryFromVal<Env, soroban_sdk::Val> + soroban_sdk::IntoVal<Env, soroban_sdk::Val>,
    V: soroban_sdk::TryFromVal<Env, soroban_sdk::Val> + soroban_sdk::IntoVal<Env, soroban_sdk::Val>,
{
    env.storage()
        .persistent()
        .get(key)
        .unwrap_or(Map::new(env))
}

fn load_config(env: &Env) -> RepConfig {
    env.storage()
        .instance()
        .get(&CONFIG)
        .unwrap_or(RepConfig::default_config())
}

/// `score * (decay_bps / 10_000) ^ periods`, in integer arithmetic.
///
/// The exponential is applied one period at a time (truncating at each step)
/// rather than in closed form: the off-chain mirror in
/// `backend/src/services/reputationEngine.js` runs the identical loop, so both
/// sides agree exactly instead of only to within a floating-point tolerance.
fn decay_score(base: u32, elapsed: u64, config: &RepConfig) -> u32 {
    if config.decay_period == 0 || config.decay_bps >= BPS_DENOM || base == 0 {
        return base;
    }

    let mut periods = elapsed / config.decay_period;
    if periods > MAX_DECAY_PERIODS {
        periods = MAX_DECAY_PERIODS;
    }

    let mut score = base as u64;
    let mut applied = 0u64;
    while applied < periods && score > 0 {
        score = score * config.decay_bps as u64 / BPS_DENOM as u64;
        applied += 1;
    }

    score as u32
}

/// Reputation of `agent_id` with decay applied, without writing anything.
fn decayed_reputation(env: &Env, agent_id: u64, base: u32) -> u32 {
    let rep_ts: Map<u64, u64> = read_map(env, &REP_TS);
    let last = match rep_ts.get(agent_id) {
        Some(ts) => ts,
        None => return base,
    };

    let now = env.ledger().timestamp();
    if now <= last {
        return base;
    }

    decay_score(base, now - last, &load_config(env))
}

/// Decay `base`, persist the new decay clock, and return the settled score.
/// The caller is responsible for storing the returned score on the agent.
fn settle_stored_reputation(env: &Env, agent_id: u64, base: u32) -> u32 {
    let settled = decayed_reputation(env, agent_id, base);

    let mut rep_ts: Map<u64, u64> = read_map(env, &REP_TS);
    rep_ts.set(agent_id, env.ledger().timestamp());
    env.storage().persistent().set(&REP_TS, &rep_ts);

    settled
}

/// True while any dispute naming `agent` as respondent is still open.
fn has_open_dispute(env: &Env, agent: &Address) -> bool {
    let disputes: Map<u64, Dispute> = read_map(env, &DISPUTES);
    for (_, dispute) in disputes.iter() {
        if dispute.respondent == *agent && dispute.status == DisputeStatus::Open {
            return true;
        }
    }
    false
}

/// Voting weight: staked collateral scaled by the voter's own reputation.
fn voting_weight(env: &Env, voter: &Address) -> i128 {
    let stakes: Map<Address, StakeRecord> = read_map(env, &STAKES);
    let staked = match stakes.get(voter.clone()) {
        Some(record) => record.amount,
        None => return 0,
    };
    if staked <= 0 {
        return 0;
    }

    staked * best_reputation(env, voter) as i128 / BPS_DENOM as i128
}

/// Highest current (decayed) reputation among the agents an address owns.
/// Addresses that own no agent vote at the neutral starting score.
fn best_reputation(env: &Env, owner: &Address) -> u32 {
    let agents: Map<u64, Agent> = read_map(env, &AGENTS);
    let owned: Map<Address, Vec<u64>> = read_map(env, &OWNED);

    let ids = match owned.get(owner.clone()) {
        Some(ids) => ids,
        None => return 5_000,
    };

    let mut best = 0u32;
    for agent_id in ids.iter() {
        if let Some(agent) = agents.get(agent_id) {
            let current = decayed_reputation(env, agent_id, agent.reputation);
            if current > best {
                best = current;
            }
        }
    }

    if best == 0 {
        5_000
    } else {
        best
    }
}

/// Take `slash_bps` of an address's stake. Returns the amount removed.
fn slash_stake(env: &Env, agent: &Address, slash_bps: u32) -> i128 {
    let mut stakes: Map<Address, StakeRecord> = read_map(env, &STAKES);
    let mut record = match stakes.get(agent.clone()) {
        Some(record) => record,
        None => return 0,
    };

    let slashed = record.amount * slash_bps as i128 / BPS_DENOM as i128;
    if slashed <= 0 {
        return 0;
    }

    record.amount -= slashed;
    record.slashed += slashed;
    stakes.set(agent.clone(), record);
    env.storage().persistent().set(&STAKES, &stakes);

    slashed
}

/// Apply the same proportional hit to every agent the address owns.
fn penalize_owner_reputation(env: &Env, owner: &Address, slash_bps: u32) {
    let owned: Map<Address, Vec<u64>> = read_map(env, &OWNED);
    let ids = match owned.get(owner.clone()) {
        Some(ids) => ids,
        None => return,
    };

    let mut agents: Map<u64, Agent> = read_map(env, &AGENTS);
    for agent_id in ids.iter() {
        if let Some(mut agent) = agents.get(agent_id) {
            let settled = settle_stored_reputation(env, agent_id, agent.reputation);
            agent.reputation = settled * (BPS_DENOM - slash_bps) / BPS_DENOM;
            agents.set(agent_id, agent);
        }
    }

    env.storage().persistent().set(&AGENTS, &agents);
}

#[cfg(test)]
mod test;
