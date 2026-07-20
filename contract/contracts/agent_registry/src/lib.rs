#![no_std]

//! Agent Registry contract for Intelligence Rail.
//!
//! Stores on-chain identities for autonomous agents, their capability
//! declarations, reputation scores, and wallet addresses.

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Env, Map, String, Symbol, Vec,
};

const AGENTS: Symbol = symbol_short!("AGENTS");
const AGENT_CNT: Symbol = symbol_short!("AG_CNT");
const REP: Symbol = symbol_short!("REP");

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

        let vote_key = (REP, voter.clone(), agent_id);
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

    pub fn get_reputation(env: Env, agent_id: u64) -> u32 {
        let agents: Map<u64, Agent> = env
            .storage()
            .persistent()
            .get(&AGENTS)
            .unwrap_or(Map::new(&env));
        match agents.get(agent_id) {
            Some(a) => a.reputation,
            None => 0,
        }
    }
}
