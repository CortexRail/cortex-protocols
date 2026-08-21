use super::*;
use soroban_sdk::{testutils::BytesN as _, Bytes, BytesN, Env};

/// A signature over the wrong bytes must trap rather than return.
///
/// This is the property `challenge_usage_batch` relies on: it reads the trap,
/// via try_invoke_contract, as "the seller did not sign this leaf".
#[test]
fn bad_signature_traps() {
    let env = Env::default();
    let contract_id = env.register(SigCheckContract, ());
    let client = SigCheckContractClient::new(&env, &contract_id);

    let public_key = BytesN::<32>::random(&env);
    let signature = BytesN::<64>::random(&env);
    let message = Bytes::from_array(&env, &[7u8; 32]);

    // try_verify surfaces the trap as Err instead of unwinding the test.
    assert!(client.try_verify(&public_key, &message, &signature).is_err());
}
