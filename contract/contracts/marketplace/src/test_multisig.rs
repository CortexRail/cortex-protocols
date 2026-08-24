

fn setup_multisig() -> (Env, MarketplaceContractClient<'static>, Address, Address, token::StellarAssetClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let contract_id = env.register(MarketplaceContract, ());
    let client = MarketplaceContractClient::new(&env, &contract_id);
    client.initialize(&admin);

    let token_admin = Address::generate(&env);
    let token_addr = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_client = token::StellarAssetClient::new(&env, &token_addr.address());

    let seller = Address::generate(&env);
    (env, client, admin, seller, token_client)
}

#[test]
fn test_multisig_1_create_policy() {
    let (env, client, admin, seller, token_client) = setup_multisig();
    let org = Address::generate(&env);
    let signer1 = Address::generate(&env);
    let signer2 = Address::generate(&env);
    
    let signers = vec![&env, signer1, signer2];
    client.create_approval_policy(&org, &1000, &2, &signers);
}

#[test]
fn test_multisig_2_invalid_threshold() {
    let (env, client, admin, seller, token_client) = setup_multisig();
    let org = Address::generate(&env);
    let signers = vec![&env, Address::generate(&env)];
    
    let res = client.try_create_approval_policy(&org, &1000, &2, &signers);
    assert_eq!(res.unwrap_err().unwrap(), MarketplaceError::InvalidThreshold.into());
}

#[test]
fn test_multisig_3_propose_purchase() {
    let (env, client, admin, seller, token_client) = setup_multisig();
    let org = Address::generate(&env);
    let signers = vec![&env, Address::generate(&env)];
    client.create_approval_policy(&org, &1000, &1, &signers);

    let asset_id = client.list_asset(
        &seller,
        &String::from_str(&env, "Asset"),
        &String::from_str(&env, "Desc"),
        &AssetType::Prompt,
        &LicenseType::Perpetual,
        &100,
        &vec![&env],
    );

    let proposal_id = client.propose_purchase(&org, &asset_id, &LicenseType::Perpetual, &token_client.address);
    assert_eq!(proposal_id, 1);
}

#[test]
fn test_multisig_4_approve_purchase_no_auto_exec() {
    let (env, client, admin, seller, token_client) = setup_multisig();
    let org = Address::generate(&env);
    let s1 = Address::generate(&env);
    let s2 = Address::generate(&env);
    client.create_approval_policy(&org, &1000, &2, &vec![&env, s1.clone(), s2.clone()]);
    
    let asset_id = client.list_asset(&seller, &String::from_str(&env, "A"), &String::from_str(&env, "D"), &AssetType::Prompt, &LicenseType::Perpetual, &100, &vec![&env]);
    let proposal_id = client.propose_purchase(&org, &asset_id, &LicenseType::Perpetual, &token_client.address);

    client.approve_purchase(&s1, &proposal_id);
}

#[test]
fn test_multisig_5_approve_purchase_auto_exec() {
    let (env, client, admin, seller, token_client) = setup_multisig();
    let org = Address::generate(&env);
    let s1 = Address::generate(&env);
    let s2 = Address::generate(&env);
    client.create_approval_policy(&org, &1000, &2, &vec![&env, s1.clone(), s2.clone()]);
    
    let asset_id = client.list_asset(&seller, &String::from_str(&env, "A"), &String::from_str(&env, "D"), &AssetType::Prompt, &LicenseType::Perpetual, &100, &vec![&env]);
    let proposal_id = client.propose_purchase(&org, &asset_id, &LicenseType::Perpetual, &token_client.address);

    token_client.mint(&org, &1000);
    client.approve_purchase(&s1, &proposal_id);
    client.approve_purchase(&s2, &proposal_id);
}

#[test]
fn test_multisig_6_reject_purchase() {
    let (env, client, admin, seller, token_client) = setup_multisig();
    let org = Address::generate(&env);
    let s1 = Address::generate(&env);
    client.create_approval_policy(&org, &1000, &1, &vec![&env, s1.clone()]);
    
    let asset_id = client.list_asset(&seller, &String::from_str(&env, "A"), &String::from_str(&env, "D"), &AssetType::Prompt, &LicenseType::Perpetual, &100, &vec![&env]);
    let proposal_id = client.propose_purchase(&org, &asset_id, &LicenseType::Perpetual, &token_client.address);

    client.reject_purchase(&s1, &proposal_id, &99);
}

#[test]
fn test_multisig_7_non_signer_approve() {
    let (env, client, admin, seller, token_client) = setup_multisig();
    let org = Address::generate(&env);
    let s1 = Address::generate(&env);
    client.create_approval_policy(&org, &1000, &1, &vec![&env, s1.clone()]);
    
    let asset_id = client.list_asset(&seller, &String::from_str(&env, "A"), &String::from_str(&env, "D"), &AssetType::Prompt, &LicenseType::Perpetual, &100, &vec![&env]);
    let proposal_id = client.propose_purchase(&org, &asset_id, &LicenseType::Perpetual, &token_client.address);

    let res = client.try_approve_purchase(&Address::generate(&env), &proposal_id);
    assert_eq!(res.unwrap_err().unwrap(), MarketplaceError::NotASigner.into());
}

#[test]
fn test_multisig_8_non_signer_reject() {
    let (env, client, admin, seller, token_client) = setup_multisig();
    let org = Address::generate(&env);
    let s1 = Address::generate(&env);
    client.create_approval_policy(&org, &1000, &1, &vec![&env, s1.clone()]);
    
    let asset_id = client.list_asset(&seller, &String::from_str(&env, "A"), &String::from_str(&env, "D"), &AssetType::Prompt, &LicenseType::Perpetual, &100, &vec![&env]);
    let proposal_id = client.propose_purchase(&org, &asset_id, &LicenseType::Perpetual, &token_client.address);

    let res = client.try_reject_purchase(&Address::generate(&env), &proposal_id, &1);
    assert_eq!(res.unwrap_err().unwrap(), MarketplaceError::NotASigner.into());
}

#[test]
fn test_multisig_9_double_approve() {
    let (env, client, admin, seller, token_client) = setup_multisig();
    let org = Address::generate(&env);
    let s1 = Address::generate(&env);
    let s2 = Address::generate(&env);
    client.create_approval_policy(&org, &1000, &2, &vec![&env, s1.clone(), s2.clone()]);
    
    let asset_id = client.list_asset(&seller, &String::from_str(&env, "A"), &String::from_str(&env, "D"), &AssetType::Prompt, &LicenseType::Perpetual, &100, &vec![&env]);
    let proposal_id = client.propose_purchase(&org, &asset_id, &LicenseType::Perpetual, &token_client.address);

    client.approve_purchase(&s1, &proposal_id);
    let res = client.try_approve_purchase(&s1, &proposal_id);
    assert_eq!(res.unwrap_err().unwrap(), MarketplaceError::SignerAlreadyApproved.into());
}

#[test]
fn test_multisig_10_expire_proposals() {
    let (env, client, admin, seller, token_client) = setup_multisig();
    let org = Address::generate(&env);
    let s1 = Address::generate(&env);
    client.create_approval_policy(&org, &1000, &1, &vec![&env, s1.clone()]);
    
    let asset_id = client.list_asset(&seller, &String::from_str(&env, "A"), &String::from_str(&env, "D"), &AssetType::Prompt, &LicenseType::Perpetual, &100, &vec![&env]);
    let proposal_id = client.propose_purchase(&org, &asset_id, &LicenseType::Perpetual, &token_client.address);

    client.expire_stale_proposals(&vec![&env, proposal_id]);
    
    let res = client.try_approve_purchase(&s1, &proposal_id);
    assert_eq!(res.unwrap_err().unwrap(), MarketplaceError::ProposalNotPending.into());
}

#[test]
fn test_multisig_11_reject_already_expired() {
    let (env, client, admin, seller, token_client) = setup_multisig();
    let org = Address::generate(&env);
    let s1 = Address::generate(&env);
    client.create_approval_policy(&org, &1000, &1, &vec![&env, s1.clone()]);
    
    let asset_id = client.list_asset(&seller, &String::from_str(&env, "A"), &String::from_str(&env, "D"), &AssetType::Prompt, &LicenseType::Perpetual, &100, &vec![&env]);
    let proposal_id = client.propose_purchase(&org, &asset_id, &LicenseType::Perpetual, &token_client.address);

    client.expire_stale_proposals(&vec![&env, proposal_id]);
    
    let res = client.try_reject_purchase(&s1, &proposal_id, &1);
    assert_eq!(res.unwrap_err().unwrap(), MarketplaceError::ProposalNotPending.into());
}

#[test]
fn test_multisig_12_approve_already_rejected() {
    let (env, client, admin, seller, token_client) = setup_multisig();
    let org = Address::generate(&env);
    let s1 = Address::generate(&env);
    let s2 = Address::generate(&env);
    client.create_approval_policy(&org, &1000, &2, &vec![&env, s1.clone(), s2.clone()]);
    
    let asset_id = client.list_asset(&seller, &String::from_str(&env, "A"), &String::from_str(&env, "D"), &AssetType::Prompt, &LicenseType::Perpetual, &100, &vec![&env]);
    let proposal_id = client.propose_purchase(&org, &asset_id, &LicenseType::Perpetual, &token_client.address);

    client.reject_purchase(&s1, &proposal_id, &1);
    
    let res = client.try_approve_purchase(&s2, &proposal_id);
    assert_eq!(res.unwrap_err().unwrap(), MarketplaceError::ProposalNotPending.into());
}

#[test]
fn test_multisig_13_policy_change() {
    let (env, client, admin, seller, token_client) = setup_multisig();
    let org = Address::generate(&env);
    let s1 = Address::generate(&env);
    client.create_approval_policy(&org, &1000, &1, &vec![&env, s1.clone()]);
    
    let s2 = Address::generate(&env);
    client.create_approval_policy(&org, &2000, &1, &vec![&env, s2.clone()]);
}

#[test]
fn test_multisig_14_exact_threshold() {
    let (env, client, admin, seller, token_client) = setup_multisig();
    let org = Address::generate(&env);
    let s1 = Address::generate(&env);
    let s2 = Address::generate(&env);
    let s3 = Address::generate(&env);
    client.create_approval_policy(&org, &1000, &2, &vec![&env, s1.clone(), s2.clone(), s3.clone()]);
    
    let asset_id = client.list_asset(&seller, &String::from_str(&env, "A"), &String::from_str(&env, "D"), &AssetType::Prompt, &LicenseType::Perpetual, &100, &vec![&env]);
    let proposal_id = client.propose_purchase(&org, &asset_id, &LicenseType::Perpetual, &token_client.address);

    token_client.mint(&org, &1000);
    client.approve_purchase(&s1, &proposal_id);
    client.approve_purchase(&s2, &proposal_id);
}

#[test]
fn test_multisig_15_expire_multiple() {
    let (env, client, admin, seller, token_client) = setup_multisig();
    let org = Address::generate(&env);
    let s1 = Address::generate(&env);
    client.create_approval_policy(&org, &1000, &1, &vec![&env, s1.clone()]);
    
    let a1 = client.list_asset(&seller, &String::from_str(&env, "A1"), &String::from_str(&env, "D"), &AssetType::Prompt, &LicenseType::Perpetual, &100, &vec![&env]);
    let a2 = client.list_asset(&seller, &String::from_str(&env, "A2"), &String::from_str(&env, "D"), &AssetType::Prompt, &LicenseType::Perpetual, &100, &vec![&env]);
    
    let p1 = client.propose_purchase(&org, &a1, &LicenseType::Perpetual, &token_client.address);
    let p2 = client.propose_purchase(&org, &a2, &LicenseType::Perpetual, &token_client.address);

    client.expire_stale_proposals(&vec![&env, p1, p2]);
    
    assert_eq!(client.try_approve_purchase(&s1, &p1).unwrap_err().unwrap(), MarketplaceError::ProposalNotPending.into());
    assert_eq!(client.try_approve_purchase(&s1, &p2).unwrap_err().unwrap(), MarketplaceError::ProposalNotPending.into());
}

#[test]
fn test_multisig_16_policy_quorum() {
    let (env, client, admin, seller, token_client) = setup_multisig();
    let org = Address::generate(&env);
    let s1 = Address::generate(&env);
    client.create_approval_policy(&org, &1000, &1, &vec![&env, s1.clone()]);
    
    client.create_approval_policy(&org, &5000, &1, &vec![&env, s1.clone()]);
}
