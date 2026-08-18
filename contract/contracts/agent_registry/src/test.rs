#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token, vec, Address, BytesN, Env, String,
};

fn setup() -> (Env, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentRegistryContract, ());
    (env, contract_id)
}

#[test]
fn test_register_agent() {
    let (env, contract_id) = setup();
    let owner = Address::generate(&env);
    let client = AgentRegistryContractClient::new(&env, &contract_id);

    let caps = vec![&env, Capability::Reasoning, Capability::TextGeneration];

    let agent_id = client.register_agent(
        &owner,
        &String::from_str(&env, "Cortex-Alpha"),
        &String::from_str(&env, "General-purpose reasoning agent"),
        &caps,
    );

    assert_eq!(agent_id, 1);
    assert_eq!(client.agent_count(), 1);

    let agent = client.get_agent(&1).unwrap();
    assert!(agent.is_active);
    assert_eq!(agent.reputation, 5_000);
}

#[test]
fn test_vote_reputation() {
    let (env, contract_id) = setup();
    let owner = Address::generate(&env);
    let voter = Address::generate(&env);
    let client = AgentRegistryContractClient::new(&env, &contract_id);

    client.register_agent(
        &owner,
        &String::from_str(&env, "DataBot"),
        &String::from_str(&env, "Data analysis specialist"),
        &vec![&env, Capability::DataAnalysis],
    );

    // Vote 80/100 → new_rep = (5000 * 9 + 8000) / 10 = 5300
    client.vote_reputation(&voter, &1, &80);
    assert_eq!(client.get_reputation(&1), 5_300);
}

#[test]
fn test_multiple_voters_converge() {
    let (env, contract_id) = setup();
    let owner = Address::generate(&env);
    let client = AgentRegistryContractClient::new(&env, &contract_id);

    client.register_agent(
        &owner,
        &String::from_str(&env, "AverageBot"),
        &String::from_str(&env, "Average agent"),
        &vec![&env, Capability::Reasoning],
    );

    // 10 different voters each vote 70 → reputation converges toward 7000
    for _ in 1..=10 {
        let voter = Address::generate(&env);
        client.vote_reputation(&voter, &1, &70);
        // After first vote: 5300, second: 5270, etc. converging to 7000
    }
    // The rolling average approaches 7000 asymptotically: after ten votes it
    // has covered 1 - 0.9^10 ≈ 65% of the distance from 5000 to 7000.
    let rep = client.get_reputation(&1);
    assert_eq!(rep, 6_300);
    assert!(rep < 7_000, "reputation approaches 7000 from below");
}

#[test]
fn test_zero_vote_drives_down() {
    let (env, contract_id) = setup();
    let owner = Address::generate(&env);
    let client = AgentRegistryContractClient::new(&env, &contract_id);

    client.register_agent(
        &owner,
        &String::from_str(&env, "BadAgent"),
        &String::from_str(&env, "Poor performance"),
        &vec![&env, Capability::TextGeneration],
    );

    // Multiple 0-score votes should drive reputation down from 5000
    for _ in 0..5 {
        let voter = Address::generate(&env);
        client.vote_reputation(&voter, &1, &0);
    }

    // 5000 → 4500 → 4050 → 3645 → 3280 → 2952
    let rep = client.get_reputation(&1);
    assert!(rep < 5_000, "reputation should decrease with 0 votes");
    assert_eq!(rep, 2_952);
}

#[test]
fn test_hundred_vote_drives_up() {
    let (env, contract_id) = setup();
    let owner = Address::generate(&env);
    let client = AgentRegistryContractClient::new(&env, &contract_id);

    client.register_agent(
        &owner,
        &String::from_str(&env, "PerfectAgent"),
        &String::from_str(&env, "Excellent performance"),
        &vec![&env, Capability::Reasoning],
    );

    // Multiple 100-score votes should drive reputation up from 5000
    for _ in 0..5 {
        let voter = Address::generate(&env);
        client.vote_reputation(&voter, &1, &100);
    }

    let rep = client.get_reputation(&1);
    // 5000 → 5500 → 5950 → 6355 → 6719 → 7047
    assert!(rep > 5_000, "reputation should increase with 100 votes");
    assert_eq!(rep, 7_047);
}

#[test]
fn test_owner_cannot_vote_own_agent() {
    let (env, contract_id) = setup();
    let owner = Address::generate(&env);
    let client = AgentRegistryContractClient::new(&env, &contract_id);

    client.register_agent(
        &owner,
        &String::from_str(&env, "MyAgent"),
        &String::from_str(&env, "My own agent"),
        &vec![&env, Capability::CodeGeneration],
    );

    // Owner attempting to vote on their own agent is rejected
    let result = client.try_vote_reputation(&owner, &1, &50);
    assert!(result.is_err(), "owner should not be able to vote on own agent");
}

#[test]
fn test_score_over_100_rejected() {
    let (env, contract_id) = setup();
    let owner = Address::generate(&env);
    let voter = Address::generate(&env);
    let client = AgentRegistryContractClient::new(&env, &contract_id);

    client.register_agent(
        &owner,
        &String::from_str(&env, "TestAgent"),
        &String::from_str(&env, "Test"),
        &vec![&env, Capability::WebResearch],
    );

    // Score > 100 is rejected by the contract's range assertion
    let result = client.try_vote_reputation(&voter, &1, &101);
    assert!(result.is_err(), "score > 100 should be rejected");

    let result2 = client.try_vote_reputation(&voter, &1, &200);
    assert!(result2.is_err(), "score >> 100 should be rejected");
}

#[test]
fn test_initial_reputation_no_votes() {
    let (env, contract_id) = setup();
    let owner = Address::generate(&env);
    let client = AgentRegistryContractClient::new(&env, &contract_id);

    client.register_agent(
        &owner,
        &String::from_str(&env, "NewAgent"),
        &String::from_str(&env, "Just registered"),
        &vec![&env, Capability::AudioProcessing],
    );

    // Agent with no votes should have initial reputation of 5000
    assert_eq!(client.get_reputation(&1), 5_000);
    
    // Register another agent and verify it also starts at 5000
    client.register_agent(
        &owner,
        &String::from_str(&env, "AnotherAgent"),
        &String::from_str(&env, "Also new"),
        &vec![&env, Capability::DataAnalysis],
    );
    assert_eq!(client.get_reputation(&2), 5_000);
}

#[test]
fn test_update_capabilities() {
    let (env, contract_id) = setup();
    let owner = Address::generate(&env);
    let client = AgentRegistryContractClient::new(&env, &contract_id);

    client.register_agent(
        &owner,
        &String::from_str(&env, "VisionAgent"),
        &String::from_str(&env, "Computer vision agent"),
        &vec![&env, Capability::VisionUnderstanding],
    );

    let new_caps = vec![
        &env,
        Capability::VisionUnderstanding,
        Capability::AudioProcessing,
        Capability::DataAnalysis,
    ];
    client.update_capabilities(&owner, &1, &new_caps);

    let agent = client.get_agent(&1).unwrap();
    assert_eq!(agent.capabilities.len(), 3);
}

#[test]
fn test_deactivate_agent() {
    let (env, contract_id) = setup();
    let owner = Address::generate(&env);
    let client = AgentRegistryContractClient::new(&env, &contract_id);

    client.register_agent(
        &owner,
        &String::from_str(&env, "DeprecatedAgent"),
        &String::from_str(&env, "Being retired"),
        &vec![&env, Capability::WebResearch],
    );

    client.deactivate_agent(&owner, &1);

    let agent = client.get_agent(&1).unwrap();
    assert!(!agent.is_active);
}

// Coverage: register -> update capabilities -> deactivate lifecycle

// ─────────────────────────────────────────────────────────────────────────────
// Staking, disputes, slashing and reputation decay
// ─────────────────────────────────────────────────────────────────────────────

const DAY: u64 = 86_400;

struct Fixture {
    env: Env,
    client_id: Address,
    token: Address,
}

fn stake_fixture() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    let client_id = env.register(AgentRegistryContract, ());

    let token_admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token = sac.address();

    Fixture {
        env,
        client_id,
        token,
    }
}

impl Fixture {
    fn client(&self) -> AgentRegistryContractClient<'_> {
        AgentRegistryContractClient::new(&self.env, &self.client_id)
    }

    /// A funded address holding `amount` of the fixture token.
    fn funded_address(&self, amount: i128) -> Address {
        let holder = Address::generate(&self.env);
        token::StellarAssetClient::new(&self.env, &self.token).mint(&holder, &amount);
        holder
    }

    /// A funded address that owns a registered agent and has staked `stake`.
    fn staked_agent(&self, name: &str, stake: i128) -> (Address, u64) {
        let owner = self.funded_address(stake * 2);
        let client = self.client();
        let agent_id = client.register_agent(
            &owner,
            &String::from_str(&self.env, name),
            &String::from_str(&self.env, "fixture agent"),
            &vec![&self.env, Capability::Reasoning],
        );
        client.stake(&owner, &stake, &self.token);
        (owner, agent_id)
    }

    fn balance(&self, who: &Address) -> i128 {
        token::Client::new(&self.env, &self.token).balance(who)
    }

    fn advance(&self, seconds: u64) {
        let now = self.env.ledger().timestamp();
        self.env.ledger().with_mut(|li| li.timestamp = now + seconds);
    }

    fn evidence(&self) -> BytesN<32> {
        BytesN::from_array(&self.env, &[7u8; 32])
    }
}

// ── Staking ──────────────────────────────────────────────────────────────────

#[test]
fn test_stake_locks_collateral() {
    let fx = stake_fixture();
    let client = fx.client();
    let agent = fx.funded_address(1_000);

    client.stake(&agent, &400, &fx.token);

    let record = client.get_stake(&agent).unwrap();
    assert_eq!(record.amount, 400);
    assert_eq!(record.slashed, 0);
    assert_eq!(record.token, fx.token);
    assert_eq!(fx.balance(&agent), 600);
    assert_eq!(fx.balance(&fx.client_id), 400);
}

#[test]
fn test_stake_accumulates() {
    let fx = stake_fixture();
    let client = fx.client();
    let agent = fx.funded_address(1_000);

    client.stake(&agent, &300, &fx.token);
    client.stake(&agent, &250, &fx.token);

    assert_eq!(client.get_stake(&agent).unwrap().amount, 550);
}

#[test]
fn test_stake_rejects_non_positive_amount() {
    let fx = stake_fixture();
    let agent = fx.funded_address(1_000);

    assert!(fx.client().try_stake(&agent, &0, &fx.token).is_err());
}

#[test]
fn test_unstake_returns_collateral() {
    let fx = stake_fixture();
    let client = fx.client();
    let agent = fx.funded_address(1_000);

    client.stake(&agent, &600, &fx.token);
    client.unstake(&agent, &200);

    assert_eq!(client.get_stake(&agent).unwrap().amount, 400);
    assert_eq!(fx.balance(&agent), 600);
}

#[test]
fn test_unstake_rejects_more_than_staked() {
    let fx = stake_fixture();
    let client = fx.client();
    let agent = fx.funded_address(1_000);

    client.stake(&agent, &100, &fx.token);
    assert!(client.try_unstake(&agent, &150).is_err());
}

#[test]
fn test_unstake_blocked_while_dispute_is_open() {
    let fx = stake_fixture();
    let client = fx.client();
    let (respondent, _) = fx.staked_agent("Respondent", 1_000);
    let complainant = fx.funded_address(100);

    client.open_dispute(&complainant, &respondent, &fx.evidence());

    assert!(client.try_unstake(&respondent, &100).is_err());
}

// ── Interaction history ──────────────────────────────────────────────────────

#[test]
fn test_record_interaction_is_symmetric() {
    let fx = stake_fixture();
    let client = fx.client();
    let a = Address::generate(&fx.env);
    let b = Address::generate(&fx.env);

    client.record_interaction(&a, &b);
    client.record_interaction(&a, &b);

    assert_eq!(client.interaction_count(&a, &b), 2);
    assert_eq!(client.interaction_count(&b, &a), 2);
}

#[test]
fn test_record_interaction_rejects_self() {
    let fx = stake_fixture();
    let a = Address::generate(&fx.env);

    assert!(fx.client().try_record_interaction(&a, &a).is_err());
}

// ── Opening disputes ─────────────────────────────────────────────────────────

#[test]
fn test_open_dispute_creates_record_with_voting_window() {
    let fx = stake_fixture();
    let client = fx.client();
    let (respondent, _) = fx.staked_agent("Respondent", 1_000);
    let complainant = fx.funded_address(100);

    let dispute_id = client.open_dispute(&complainant, &respondent, &fx.evidence());
    let dispute = client.get_dispute(&dispute_id).unwrap();

    assert_eq!(dispute_id, 1);
    assert_eq!(client.dispute_count(), 1);
    assert_eq!(dispute.respondent, respondent);
    assert_eq!(dispute.status, DisputeStatus::Open);
    assert_eq!(dispute.outcome, DisputeOutcome::Pending);
    assert_eq!(dispute.closes_at, dispute.opened_at + client.get_config().voting_window);
}

#[test]
fn test_open_dispute_requires_a_stake_to_slash() {
    let fx = stake_fixture();
    let client = fx.client();
    let respondent = fx.funded_address(500); // funded but never staked
    let complainant = fx.funded_address(100);

    assert!(client
        .try_open_dispute(&complainant, &respondent, &fx.evidence())
        .is_err());
}

#[test]
fn test_open_dispute_rejects_self_dispute() {
    let fx = stake_fixture();
    let client = fx.client();
    let (respondent, _) = fx.staked_agent("Respondent", 1_000);

    assert!(client
        .try_open_dispute(&respondent, &respondent, &fx.evidence())
        .is_err());
}

#[test]
fn test_open_dispute_rejects_a_second_open_dispute() {
    let fx = stake_fixture();
    let client = fx.client();
    let (respondent, _) = fx.staked_agent("Respondent", 1_000);
    let complainant = fx.funded_address(100);

    client.open_dispute(&complainant, &respondent, &fx.evidence());

    assert!(client
        .try_open_dispute(&complainant, &respondent, &fx.evidence())
        .is_err());
}

// ── Voting ───────────────────────────────────────────────────────────────────

/// Registers a voter that has staked and transacted with `respondent`.
fn eligible_voter(fx: &Fixture, respondent: &Address, stake: i128, name: &str) -> Address {
    let (voter, _) = fx.staked_agent(name, stake);
    fx.client().record_interaction(&voter, respondent);
    voter
}

#[test]
fn test_vote_dispute_records_weighted_vote() {
    let fx = stake_fixture();
    let client = fx.client();
    let (respondent, _) = fx.staked_agent("Respondent", 1_000);
    let complainant = fx.funded_address(100);
    let voter = eligible_voter(&fx, &respondent, 2_000, "Voter");

    let dispute_id = client.open_dispute(&complainant, &respondent, &fx.evidence());
    client.vote_dispute(&voter, &dispute_id, &true);

    let dispute = client.get_dispute(&dispute_id).unwrap();
    // weight = stake 2000 × reputation 5000bp / 10000 = 1000
    assert_eq!(dispute.weight_for, 1_000);
    assert_eq!(dispute.weight_against, 0);
    assert_eq!(dispute.vote_count, 1);
    assert_eq!(client.get_vote(&dispute_id, &voter), Some(true));
}

#[test]
fn test_vote_weight_scales_with_stake_and_reputation() {
    let fx = stake_fixture();
    let client = fx.client();
    let (voter, voter_agent) = fx.staked_agent("Voter", 2_000);

    assert_eq!(client.get_voting_weight(&voter), 1_000);

    // Five 100-votes raise the voter's own reputation to 7047bp.
    for _ in 0..5 {
        let rater = Address::generate(&fx.env);
        client.vote_reputation(&rater, &voter_agent, &100);
    }

    assert_eq!(client.get_reputation(&voter_agent), 7_047);
    assert_eq!(client.get_voting_weight(&voter), 2_000 * 7_047 / 10_000);
}

#[test]
fn test_vote_dispute_rejects_voter_without_interaction_history() {
    let fx = stake_fixture();
    let client = fx.client();
    let (respondent, _) = fx.staked_agent("Respondent", 1_000);
    let complainant = fx.funded_address(100);
    // Staked, but never transacted with the respondent — a brigading account.

    let (brigader, _) = fx.staked_agent("Brigader", 5_000);

    let dispute_id = client.open_dispute(&complainant, &respondent, &fx.evidence());

    assert!(client.try_vote_dispute(&brigader, &dispute_id, &true).is_err());
    assert_eq!(client.get_dispute(&dispute_id).unwrap().weight_for, 0);
}

#[test]
fn test_vote_dispute_rejects_voter_without_stake() {
    let fx = stake_fixture();
    let client = fx.client();
    let (respondent, _) = fx.staked_agent("Respondent", 1_000);
    let complainant = fx.funded_address(100);

    // Throwaway account: it has an interaction record but no collateral, so it
    // carries no weight and cannot vote.
    let throwaway = Address::generate(&fx.env);
    client.record_interaction(&throwaway, &respondent);

    let dispute_id = client.open_dispute(&complainant, &respondent, &fx.evidence());

    assert_eq!(client.get_voting_weight(&throwaway), 0);
    assert!(client.try_vote_dispute(&throwaway, &dispute_id, &true).is_err());
}

#[test]
fn test_vote_dispute_rejects_double_voting() {
    let fx = stake_fixture();
    let client = fx.client();
    let (respondent, _) = fx.staked_agent("Respondent", 1_000);
    let complainant = fx.funded_address(100);
    let voter = eligible_voter(&fx, &respondent, 2_000, "Voter");

    let dispute_id = client.open_dispute(&complainant, &respondent, &fx.evidence());
    client.vote_dispute(&voter, &dispute_id, &true);

    assert!(client.try_vote_dispute(&voter, &dispute_id, &false).is_err());
    assert_eq!(client.get_dispute(&dispute_id).unwrap().vote_count, 1);
}

#[test]
fn test_vote_dispute_rejects_the_respondent() {
    let fx = stake_fixture();
    let client = fx.client();
    let (respondent, _) = fx.staked_agent("Respondent", 1_000);
    let complainant = fx.funded_address(100);
    client.record_interaction(&respondent, &complainant);

    let dispute_id = client.open_dispute(&complainant, &respondent, &fx.evidence());

    assert!(client
        .try_vote_dispute(&respondent, &dispute_id, &false)
        .is_err());
}

#[test]
fn test_vote_dispute_rejects_votes_after_the_window_closes() {
    let fx = stake_fixture();
    let client = fx.client();
    let (respondent, _) = fx.staked_agent("Respondent", 1_000);
    let complainant = fx.funded_address(100);
    let voter = eligible_voter(&fx, &respondent, 2_000, "Voter");

    let dispute_id = client.open_dispute(&complainant, &respondent, &fx.evidence());
    fx.advance(client.get_config().voting_window + 1);

    assert!(client.try_vote_dispute(&voter, &dispute_id, &true).is_err());
}

// ── Resolution and slashing ──────────────────────────────────────────────────

#[test]
fn test_resolve_dispute_rejected_before_the_window_closes() {
    let fx = stake_fixture();
    let client = fx.client();
    let (respondent, _) = fx.staked_agent("Respondent", 1_000);
    let complainant = fx.funded_address(100);

    let dispute_id = client.open_dispute(&complainant, &respondent, &fx.evidence());

    assert!(client.try_resolve_dispute(&dispute_id).is_err());
}

#[test]
fn test_resolve_guilty_slashes_stake_and_reputation() {
    let fx = stake_fixture();
    let client = fx.client();
    let (respondent, respondent_agent) = fx.staked_agent("Respondent", 10_000);
    let complainant = fx.funded_address(100);
    let voter = eligible_voter(&fx, &respondent, 10_000, "Voter");

    let dispute_id = client.open_dispute(&complainant, &respondent, &fx.evidence());
    client.vote_dispute(&voter, &dispute_id, &true);
    fx.advance(client.get_config().voting_window + 1);

    // Reputation as it stands when the verdict lands (the open window itself
    // has decayed it), so the assertion isolates the slashing penalty.
    let before = client.get_reputation(&respondent_agent);
    let outcome = client.resolve_dispute(&dispute_id);

    assert_eq!(outcome, DisputeOutcome::Guilty);
    // 20% of a 10 000 stake
    let stake = client.get_stake(&respondent).unwrap();
    assert_eq!(stake.amount, 8_000);
    assert_eq!(stake.slashed, 2_000);
    // The same 20% comes off every agent the respondent owns
    assert_eq!(client.get_reputation(&respondent_agent), before * 8 / 10);

    let dispute = client.get_dispute(&dispute_id).unwrap();
    assert_eq!(dispute.status, DisputeStatus::Resolved);
    assert_eq!(dispute.outcome, DisputeOutcome::Guilty);
    assert_eq!(dispute.slashed_amount, 2_000);
}

#[test]
fn test_resolve_not_guilty_leaves_the_stake_intact() {
    let fx = stake_fixture();
    let client = fx.client();
    let (respondent, respondent_agent) = fx.staked_agent("Respondent", 10_000);
    let complainant = fx.funded_address(100);
    let defender = eligible_voter(&fx, &respondent, 10_000, "Defender");

    let dispute_id = client.open_dispute(&complainant, &respondent, &fx.evidence());
    client.vote_dispute(&defender, &dispute_id, &false);
    fx.advance(client.get_config().voting_window + 1);

    let before = client.get_reputation(&respondent_agent);
    assert_eq!(client.resolve_dispute(&dispute_id), DisputeOutcome::NotGuilty);
    assert_eq!(client.get_stake(&respondent).unwrap().amount, 10_000);
    assert_eq!(client.get_reputation(&respondent_agent), before);
}

#[test]
fn test_resolve_without_quorum_slashes_nothing() {
    let fx = stake_fixture();
    let client = fx.client();
    let (respondent, _) = fx.staked_agent("Respondent", 10_000);
    let complainant = fx.funded_address(100);
    // Weight 1000 × 5000bp / 10000 = 500, below the 1000 quorum.
    let voter = eligible_voter(&fx, &respondent, 1_000, "SmallVoter");

    let dispute_id = client.open_dispute(&complainant, &respondent, &fx.evidence());
    client.vote_dispute(&voter, &dispute_id, &true);
    fx.advance(client.get_config().voting_window + 1);

    assert_eq!(
        client.resolve_dispute(&dispute_id),
        DisputeOutcome::QuorumFailed
    );
    assert_eq!(client.get_stake(&respondent).unwrap().amount, 10_000);
}

#[test]
fn test_resolve_rejects_a_second_resolution() {
    let fx = stake_fixture();
    let client = fx.client();
    let (respondent, _) = fx.staked_agent("Respondent", 10_000);
    let complainant = fx.funded_address(100);

    let dispute_id = client.open_dispute(&complainant, &respondent, &fx.evidence());
    fx.advance(client.get_config().voting_window + 1);
    client.resolve_dispute(&dispute_id);

    assert!(client.try_resolve_dispute(&dispute_id).is_err());
}

// ── Time decay ───────────────────────────────────────────────────────────────

#[test]
fn test_reputation_decays_with_ledger_time() {
    let fx = stake_fixture();
    let client = fx.client();
    let (_, agent_id) = fx.staked_agent("Decayer", 1_000);

    assert_eq!(client.get_reputation(&agent_id), 5_000);

    // One period: 5000 × 0.99
    fx.advance(DAY);
    assert_eq!(client.get_reputation(&agent_id), 4_950);

    // Ten periods total: 5000 × 0.99 applied ten times, truncating each period
    fx.advance(DAY * 9);
    assert_eq!(client.get_reputation(&agent_id), 4_517);
}

#[test]
fn test_decay_only_applies_on_whole_periods() {
    let fx = stake_fixture();
    let client = fx.client();
    let (_, agent_id) = fx.staked_agent("Decayer", 1_000);

    fx.advance(DAY - 1);
    assert_eq!(client.get_reputation(&agent_id), 5_000);
}

#[test]
fn test_settle_reputation_persists_the_decayed_score() {
    let fx = stake_fixture();
    let client = fx.client();
    let (_, agent_id) = fx.staked_agent("Decayer", 1_000);

    fx.advance(DAY * 5);
    let settled = client.settle_reputation(&agent_id);

    assert_eq!(settled, client.get_reputation(&agent_id));
    assert_eq!(client.get_stored_reputation(&agent_id), settled);
    assert_eq!(client.get_reputation_updated_at(&agent_id), DAY * 5);
}

#[test]
fn test_vote_is_applied_to_the_decayed_score() {
    let fx = stake_fixture();
    let client = fx.client();
    let (_, agent_id) = fx.staked_agent("Decayer", 1_000);
    let rater = Address::generate(&fx.env);

    fx.advance(DAY * 10); // 5000 → 4517
    assert_eq!(client.get_reputation(&agent_id), 4_517);
    client.vote_reputation(&rater, &agent_id, &100);

    // (4517 × 9 + 10000) / 10 — the vote lands on the decayed score, not on 5000
    assert_eq!(client.get_reputation(&agent_id), 5_065);
}

#[test]
fn test_decay_is_bounded_for_dormant_agents() {
    let fx = stake_fixture();
    let client = fx.client();
    let (_, agent_id) = fx.staked_agent("Dormant", 1_000);

    fx.advance(DAY * 730);
    let two_years = client.get_reputation(&agent_id);

    fx.advance(DAY * 3_650);
    assert_eq!(
        client.get_reputation(&agent_id),
        two_years,
        "decay saturates at the iteration bound"
    );
}

// ── Configuration ────────────────────────────────────────────────────────────

#[test]
fn test_configure_sets_parameters_and_locks_the_admin() {
    let fx = stake_fixture();
    let client = fx.client();
    let admin = Address::generate(&fx.env);
    let intruder = Address::generate(&fx.env);

    let config = RepConfig {
        slash_bps: 5_000,
        voting_window: DAY,
        quorum_weight: 10,
        decay_bps: 9_000,
        decay_period: DAY,
    };
    client.configure(&admin, &config);

    assert_eq!(client.get_config().slash_bps, 5_000);
    assert_eq!(client.get_config().voting_window, DAY);
    assert!(client.try_configure(&intruder, &config).is_err());
}

#[test]
fn test_configured_slash_percentage_is_applied() {
    let fx = stake_fixture();
    let client = fx.client();
    let admin = Address::generate(&fx.env);
    client.configure(
        &admin,
        &RepConfig {
            slash_bps: 5_000,
            voting_window: DAY,
            quorum_weight: 10,
            decay_bps: 9_900,
            decay_period: DAY,
        },
    );

    let (respondent, _) = fx.staked_agent("Respondent", 10_000);
    let complainant = fx.funded_address(100);
    let voter = eligible_voter(&fx, &respondent, 10_000, "Voter");

    let dispute_id = client.open_dispute(&complainant, &respondent, &fx.evidence());
    client.vote_dispute(&voter, &dispute_id, &true);
    fx.advance(DAY + 1);

    assert_eq!(client.resolve_dispute(&dispute_id), DisputeOutcome::Guilty);
    assert_eq!(client.get_stake(&respondent).unwrap().amount, 5_000);
}

// ── End-to-end ───────────────────────────────────────────────────────────────

#[test]
fn test_end_to_end_stake_dispute_slash_flow() {
    let fx = stake_fixture();
    let client = fx.client();

    // Agent A stakes and builds a reputation.
    let (agent_a, agent_a_id) = fx.staked_agent("Agent A", 10_000);
    for _ in 0..5 {
        let rater = Address::generate(&fx.env);
        client.vote_reputation(&rater, &agent_a_id, &100);
    }
    assert_eq!(client.get_reputation(&agent_a_id), 7_047);

    // Agent B, who has transacted with A, disputes it.
    let (agent_b, _) = fx.staked_agent("Agent B", 5_000);
    client.record_interaction(&agent_b, &agent_a);

    let dispute_id = client.open_dispute(&agent_b, &agent_a, &fx.evidence());

    // Third parties who have dealt with A weigh in.
    let third_party = eligible_voter(&fx, &agent_a, 8_000, "Third Party");
    let defender = eligible_voter(&fx, &agent_a, 2_000, "Defender");
    client.vote_dispute(&agent_b, &dispute_id, &true);
    client.vote_dispute(&third_party, &dispute_id, &true);
    client.vote_dispute(&defender, &dispute_id, &false);

    let dispute = client.get_dispute(&dispute_id).unwrap();
    assert_eq!(dispute.vote_count, 3);
    assert!(dispute.weight_for > dispute.weight_against);

    // The window closes and the verdict lands.
    fx.advance(client.get_config().voting_window + 1);
    let reputation_at_verdict = client.get_reputation(&agent_a_id);
    assert!(
        reputation_at_verdict < 7_047,
        "the open window itself decays the score"
    );
    assert_eq!(client.resolve_dispute(&dispute_id), DisputeOutcome::Guilty);

    // A's stake is provably reduced and its reputation drops by the same share.
    let stake = client.get_stake(&agent_a).unwrap();
    assert_eq!(stake.amount, 8_000);
    assert_eq!(stake.slashed, 2_000);
    assert_eq!(
        client.get_reputation(&agent_a_id),
        reputation_at_verdict * 8 / 10
    );

    // With the dispute resolved, A can withdraw what is left.
    client.unstake(&agent_a, &8_000);
    assert_eq!(client.get_stake(&agent_a).unwrap().amount, 0);
}
