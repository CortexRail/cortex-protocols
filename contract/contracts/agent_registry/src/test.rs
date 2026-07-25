#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, vec, Address, Env, String};

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
    for i in 1..=10 {
        let voter = Address::generate(&env);
        client.vote_reputation(&voter, &1, &70);
        // After first vote: 5300, second: 5270, etc. converging to 7000
    }
    // After multiple votes from different voters, should be close to 7000
    let rep = client.get_reputation(&1);
    assert!(rep >= 6_900 && rep <= 7_100, "reputation should converge to ~7000");
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

    let rep = client.get_reputation(&1);
    assert!(rep < 5_000, "reputation should decrease with 0 votes");
    assert!(rep >= 4_000 && rep <= 4_500, "after five 0-votes, rep should be ~4500");
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
    assert!(rep > 5_000, "reputation should increase with 100 votes");
    assert!(rep >= 9_000 && rep <= 9_500, "after five 100-votes, rep should be ~9500");
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

    // Owner attempting to vote on their own agent should panic
    let result = std::panic::catch_unwind(|| {
        client.vote_reputation(&owner, &1, &50);
    });
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

    // Score > 100 should be rejected with panic from assertion
    let result = std::panic::catch_unwind(|| {
        client.vote_reputation(&voter, &1, &101);
    });
    assert!(result.is_err(), "score > 100 should be rejected");
    
    let result2 = std::panic::catch_unwind(|| {
        client.vote_reputation(&voter, &1, &200);
    });
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
