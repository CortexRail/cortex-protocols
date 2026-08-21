//! Proof-of-execution attestation: zero-trust usage metering.
//!
//! Ordinary metering asks everyone to trust the backend's counters. This module
//! replaces that trust with two cryptographic commitments:
//!
//!   1. Per call, the seller's own service signs an attestation describing what
//!      it served. The backend never holds that key and cannot fabricate one.
//!   2. Per batch, the seller commits a Merkle root over N such attestations
//!      and is charged for exactly N calls. One 32-byte write covers the batch.
//!
//! A buyer who thinks a batch is padded fetches the archived attestations,
//! finds the bad one, and proves it — `challenge_usage_batch` re-derives the
//! root from the disputed leaf and reverses the charge.
//!
//! ## Wire format
//!
//! Byte-for-byte identical to `backend/src/attestation/canonical.js`; that file
//! carries the full field table. In brief, a leaf preimage is 120 fixed-width
//! big-endian bytes and every hash is domain-tagged:
//!
//!   leaf      sha256(0x00 || stream_id | call_index | req | resp | ts | nonce)
//!   internal  sha256(0x01 || min(a,b) || max(a,b))
//!   batch     signed over 0x02 || stream_id || merkle_root || call_count
//!
//! Internal nodes sort their children so a proof needs no direction bits, which
//! is what lets `merkle_proof` be a bare `Vec<BytesN<32>>`. Position is not
//! taken from the proof — it comes from the leaf's own `call_index` measured
//! against the batch's committed `first_call_index`.
//!
//! ## Funds
//!
//! Usage billing runs beside the time-based stream rather than through it: a
//! buyer escrows an allowance with `fund_usage_meter`, `record_usage_batch`
//! moves `call_count * price_per_call` from that allowance into the seller's
//! claimable column, and the seller can only take it once the challenge window
//! has closed. That window is the whole reason a dispute can be funds-correct:
//! money that has already left cannot be clawed back, so it is made to wait.
//!
//! ## Partial voiding
//!
//! A successful challenge voids the disputed call *and every call after it in
//! the batch* — a suffix, not just the one leaf. Once a seller is shown to have
//! inserted a fabricated call at position k, the indices of everything at k+1
//! and beyond are no longer evidence of anything: they are numbered relative to
//! a sequence that is known to contain an invention. Voiding the whole batch
//! instead would over-refund the calls before k, which really were attested.

use soroban_sdk::{
    contractimpl, contracttype, symbol_short, token, Address, Bytes, BytesN, Env, IntoVal, Symbol,
    Vec,
};

use crate::{MicropaymentsContract, MicropaymentsContractArgs, MicropaymentsContractClient};
use crate::{PaymentStream, StreamStatus, STREAMS};

/// Domain tags. Keep in lockstep with canonical.js.
const DOMAIN_LEAF: u8 = 0x00;
const DOMAIN_INTERNAL: u8 = 0x01;
const DOMAIN_BATCH: u8 = 0x02;

/// How long after `record_usage_batch` a buyer may still dispute, in seconds.
///
/// The seller cannot claim inside this window. Long enough for a buyer to pull
/// the archive and check 128 signatures without racing anyone; short enough
/// that an honest seller is not financing the protocol.
pub const CHALLENGE_WINDOW_SECS: u64 = 86_400;

const SIG_CHECKER: Symbol = symbol_short!("SIGCHK");

/// One signed statement that a specific call happened.
///
/// Every field except `signature` is covered by `signature`, so a leaf that has
/// been altered anywhere fails verification exactly as a forged one does.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttestationLeaf {
    pub stream_id: u64,
    /// Strictly increasing per stream. Its distance from the batch's
    /// `first_call_index` is the leaf's position, and therefore the refund.
    pub call_index: u64,
    pub request_hash: BytesN<32>,
    pub response_hash: BytesN<32>,
    pub timestamp: u64,
    pub nonce: BytesN<32>,
    pub signature: BytesN<64>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BatchStatus {
    /// Committed and charged; inside or past the challenge window.
    Recorded,
    /// A challenge succeeded but some earlier calls in the batch still stand.
    Challenged,
    /// Every call in the batch was reversed.
    Voided,
    /// Paid out to the seller; no longer disputable.
    Claimed,
}

/// An on-chain usage commitment.
#[contracttype]
#[derive(Clone, Debug)]
pub struct UsageBatch {
    pub id: u64,
    pub stream_id: u64,
    pub seller: Address,
    pub merkle_root: BytesN<32>,
    pub call_count: u64,
    /// `call_index` of the batch's first leaf. Batches are contiguous, so this
    /// plus `call_count` fully describes which calls the root covers.
    pub first_call_index: u64,
    /// What the batch cost the buyer when recorded.
    pub charged: i128,
    /// Length of the voided suffix; 0 while the batch stands whole.
    pub voided_calls: u64,
    pub refunded: i128,
    pub recorded_at: u64,
    pub status: BatchStatus,
}

/// Per-stream usage accounting.
#[contracttype]
#[derive(Clone, Debug)]
pub struct UsageMeter {
    pub price_per_call: i128,
    /// The buyer's remaining allowance — what `record_usage_batch` draws down.
    pub escrowed: i128,
    /// Charged to the seller's claimable column, net of refunds.
    pub charged: i128,
    /// Already paid out.
    pub claimed: i128,
    /// The `call_index` the next batch must start at.
    pub next_call_index: u64,
    pub batch_count: u64,
}

#[contracttype]
pub enum AttKey {
    /// stream_id -> UsageMeter
    Meter(u64),
    /// (stream_id, batch_id) -> UsageBatch
    Batch(u64, u64),
    /// seller -> the Ed25519 key its attestations are signed with
    SellerKey(Address),
}

// ── Hashing ──────────────────────────────────────────────────────────────────

/// `0x00 || LEAF_PREIMAGE` — both the signed message and the leaf-hash input.
///
/// Making those the same bytes is deliberate: a leaf that verifies as signed is
/// necessarily the leaf that was committed, with no room for the two views to
/// disagree.
pub(crate) fn leaf_message(env: &Env, leaf: &AttestationLeaf) -> Bytes {
    let mut msg = Bytes::new(env);
    msg.extend_from_array(&[DOMAIN_LEAF]);
    msg.extend_from_array(&leaf.stream_id.to_be_bytes());
    msg.extend_from_array(&leaf.call_index.to_be_bytes());
    msg.extend_from_array(&leaf.request_hash.to_array());
    msg.extend_from_array(&leaf.response_hash.to_array());
    msg.extend_from_array(&leaf.timestamp.to_be_bytes());
    msg.extend_from_array(&leaf.nonce.to_array());
    msg
}

pub(crate) fn leaf_hash(env: &Env, leaf: &AttestationLeaf) -> BytesN<32> {
    env.crypto().sha256(&leaf_message(env, leaf)).into()
}

/// sha256(0x01 || min(a,b) || max(a,b)) — children ordered by byte value.
pub(crate) fn hash_internal(env: &Env, a: &BytesN<32>, b: &BytesN<32>) -> BytesN<32> {
    let (lo, hi) = if a.to_array() <= b.to_array() {
        (a.to_array(), b.to_array())
    } else {
        (b.to_array(), a.to_array())
    };

    let mut buf = Bytes::new(env);
    buf.extend_from_array(&[DOMAIN_INTERNAL]);
    buf.extend_from_array(&lo);
    buf.extend_from_array(&hi);
    env.crypto().sha256(&buf).into()
}

/// Walk a leaf up to a root through its sibling hashes.
pub(crate) fn root_from_proof(env: &Env, leaf: &BytesN<32>, proof: &Vec<BytesN<32>>) -> BytesN<32> {
    let mut node = leaf.clone();
    for sibling in proof.iter() {
        node = hash_internal(env, &node, &sibling);
    }
    node
}

/// The bytes a seller signs to commit a batch.
///
/// `stream_id` is folded in alongside the (merkle_root, call_count) pair the
/// protocol nominally commits to, so a signature captured on one stream cannot
/// be replayed to charge another that happens to share a root.
pub(crate) fn batch_message(env: &Env, stream_id: u64, root: &BytesN<32>, call_count: u64) -> Bytes {
    let mut msg = Bytes::new(env);
    msg.extend_from_array(&[DOMAIN_BATCH]);
    msg.extend_from_array(&stream_id.to_be_bytes());
    msg.extend_from_array(&root.to_array());
    msg.extend_from_array(&call_count.to_be_bytes());
    msg
}

// ── Storage helpers ──────────────────────────────────────────────────────────

fn load_stream(env: &Env, stream_id: u64) -> PaymentStream {
    let streams: soroban_sdk::Map<u64, PaymentStream> = env
        .storage()
        .persistent()
        .get(&STREAMS)
        .unwrap_or(soroban_sdk::Map::new(env));
    streams.get(stream_id).expect("stream not found")
}

fn load_meter(env: &Env, stream_id: u64) -> UsageMeter {
    env.storage()
        .persistent()
        .get(&AttKey::Meter(stream_id))
        .expect("usage meter not funded for this stream")
}

fn save_meter(env: &Env, stream_id: u64, meter: &UsageMeter) {
    env.storage()
        .persistent()
        .set(&AttKey::Meter(stream_id), meter);
}

fn load_batch(env: &Env, stream_id: u64, batch_id: u64) -> UsageBatch {
    env.storage()
        .persistent()
        .get(&AttKey::Batch(stream_id, batch_id))
        .expect("usage batch not found")
}

fn save_batch(env: &Env, batch: &UsageBatch) {
    env.storage()
        .persistent()
        .set(&AttKey::Batch(batch.stream_id, batch.id), batch);
}

/// True when `signature` is a good Ed25519 signature over `message`.
///
/// Routed through the registered sig_check contract because
/// `env.crypto().ed25519_verify` panics on a bad signature and Soroban forbids
/// re-entering this contract to catch it. See contracts/sig_check.
fn signature_is_valid(
    env: &Env,
    public_key: &BytesN<32>,
    message: &Bytes,
    signature: &BytesN<64>,
) -> bool {
    let checker: Address = env
        .storage()
        .instance()
        .get(&SIG_CHECKER)
        .expect("sig checker not configured; call set_sig_checker first");

    env.try_invoke_contract::<(), soroban_sdk::Error>(
        &checker,
        &Symbol::new(env, "verify"),
        soroban_sdk::vec![
            env,
            public_key.into_val(env),
            message.into_val(env),
            signature.into_val(env)
        ],
    )
    .is_ok()
}

/// The leaf's 0-based position within its batch.
///
/// Derived from committed values only — `first_call_index` is fixed at record
/// time and `call_index` is inside the signed leaf — so a challenger cannot
/// choose a position that inflates their refund.
fn position_in_batch(batch: &UsageBatch, leaf: &AttestationLeaf) -> u64 {
    assert!(
        leaf.call_index >= batch.first_call_index,
        "leaf precedes the batch"
    );
    let position = leaf.call_index - batch.first_call_index;
    assert!(position < batch.call_count, "leaf is past the end of the batch");
    position
}

/// Reverse the suffix starting at `position` and move the money back.
///
/// Idempotent in the sense that matters: a second challenge naming a *later*
/// call is rejected (the suffix would shrink), and one naming an earlier call
/// only refunds the difference, so a batch can never refund more than it
/// charged.
fn void_suffix(batch: &mut UsageBatch, meter: &mut UsageMeter, position: u64) -> u64 {
    let new_voided = batch.call_count - position;
    assert!(
        new_voided > batch.voided_calls,
        "this call is already covered by an earlier successful challenge"
    );

    let newly_voided = new_voided - batch.voided_calls;
    let refund = (newly_voided as i128) * meter.price_per_call;

    // Charge leaves the seller's claimable column and returns to the buyer's
    // allowance, where it can be spent on further calls or withdrawn.
    meter.charged -= refund;
    meter.escrowed += refund;

    batch.voided_calls = new_voided;
    batch.refunded += refund;
    batch.status = if new_voided == batch.call_count {
        BatchStatus::Voided
    } else {
        BatchStatus::Challenged
    };

    newly_voided
}

#[contractimpl]
impl MicropaymentsContract {
    // ── Configuration ────────────────────────────────────────────────────────

    /// Point the contract at its Ed25519 checker.
    ///
    /// Write-once. The checker decides every challenge, so a swappable one
    /// would let whoever could swap it either void honest batches or protect
    /// fraudulent ones. Set at deploy, then it is settled.
    pub fn set_sig_checker(env: Env, checker: Address) {
        assert!(
            !env.storage().instance().has(&SIG_CHECKER),
            "sig checker already set"
        );
        env.storage().instance().set(&SIG_CHECKER, &checker);
    }

    pub fn get_sig_checker(env: Env) -> Option<Address> {
        env.storage().instance().get(&SIG_CHECKER)
    }

    /// Register the Ed25519 key a seller signs attestations with.
    ///
    /// A Soroban `Address` does not expose the raw key behind it, so the
    /// mapping has to be declared. `require_auth` means only the seller can
    /// declare it — nobody can bind a key they do not control to someone else's
    /// address, and a seller re-keying invalidates only their own future
    /// batches.
    pub fn register_attestation_key(env: Env, seller: Address, public_key: BytesN<32>) {
        seller.require_auth();
        env.storage()
            .persistent()
            .set(&AttKey::SellerKey(seller.clone()), &public_key);

        env.events()
            .publish((Symbol::new(&env, "ATTEST_KEY_REGISTERED"), seller), public_key);
    }

    pub fn get_attestation_key(env: Env, seller: Address) -> Option<BytesN<32>> {
        env.storage().persistent().get(&AttKey::SellerKey(seller))
    }

    // ── Buyer: funding the allowance ─────────────────────────────────────────

    /// Escrow an allowance for per-call billing on a stream.
    ///
    /// `price_per_call` is fixed by the first funding. Letting a later top-up
    /// change it would silently reprice calls that were already attested but
    /// not yet batched.
    pub fn fund_usage_meter(
        env: Env,
        buyer: Address,
        stream_id: u64,
        price_per_call: i128,
        amount: i128,
    ) -> i128 {
        buyer.require_auth();
        assert!(price_per_call > 0, "price_per_call must be positive");
        assert!(amount > 0, "amount must be positive");

        let stream = load_stream(&env, stream_id);
        assert!(stream.sender == buyer, "not the stream sender");
        assert!(
            stream.status == StreamStatus::Active || stream.status == StreamStatus::Paused,
            "stream is closed"
        );

        let token_client = token::Client::new(&env, &stream.token);
        token_client.transfer(&buyer, &env.current_contract_address(), &amount);

        let mut meter = env
            .storage()
            .persistent()
            .get(&AttKey::Meter(stream_id))
            .unwrap_or(UsageMeter {
                price_per_call,
                escrowed: 0,
                charged: 0,
                claimed: 0,
                next_call_index: 0,
                batch_count: 0,
            });

        assert!(
            meter.price_per_call == price_per_call,
            "price_per_call is fixed for the life of the meter"
        );

        meter.escrowed += amount;
        save_meter(&env, stream_id, &meter);

        env.events().publish(
            (Symbol::new(&env, "USAGE_METER_FUNDED"), buyer),
            (stream_id, amount, meter.escrowed),
        );

        meter.escrowed
    }

    /// Withdraw unspent allowance. Only touches `escrowed`, so money already
    /// charged for recorded calls is out of reach until it is voided.
    pub fn withdraw_usage_escrow(env: Env, buyer: Address, stream_id: u64, amount: i128) -> i128 {
        buyer.require_auth();
        assert!(amount > 0, "amount must be positive");

        let stream = load_stream(&env, stream_id);
        assert!(stream.sender == buyer, "not the stream sender");

        let mut meter = load_meter(&env, stream_id);
        assert!(meter.escrowed >= amount, "insufficient unspent allowance");

        meter.escrowed -= amount;
        save_meter(&env, stream_id, &meter);

        let token_client = token::Client::new(&env, &stream.token);
        token_client.transfer(&env.current_contract_address(), &buyer, &amount);

        meter.escrowed
    }

    // ── Seller: committing usage ─────────────────────────────────────────────

    /// Commit a Merkle root over `call_count` attestations and charge for them.
    ///
    /// The signature check here is the strict one: a batch whose commitment
    /// does not verify must not be recorded at all, so a panic is the correct
    /// outcome and `ed25519_verify` is called directly.
    ///
    /// Returns the new batch id.
    pub fn record_usage_batch(
        env: Env,
        seller: Address,
        stream_id: u64,
        merkle_root: BytesN<32>,
        call_count: u64,
        batch_signature: BytesN<64>,
    ) -> u64 {
        seller.require_auth();
        assert!(call_count > 0, "a batch must cover at least one call");

        let stream = load_stream(&env, stream_id);
        assert!(stream.recipient == seller, "not the stream recipient");
        assert!(
            stream.status == StreamStatus::Active,
            "stream is not active"
        );

        let public_key: BytesN<32> = env
            .storage()
            .persistent()
            .get(&AttKey::SellerKey(seller.clone()))
            .expect("seller has no registered attestation key");

        env.crypto().ed25519_verify(
            &public_key,
            &batch_message(&env, stream_id, &merkle_root, call_count),
            &batch_signature,
        );

        let mut meter = load_meter(&env, stream_id);
        let charge = (call_count as i128) * meter.price_per_call;
        assert!(
            meter.escrowed >= charge,
            "usage allowance exhausted: fund the meter before recording"
        );

        meter.escrowed -= charge;
        meter.charged += charge;

        let batch_id = meter.batch_count + 1;
        let first_call_index = meter.next_call_index;
        meter.batch_count = batch_id;
        meter.next_call_index = first_call_index + call_count;
        save_meter(&env, stream_id, &meter);

        let batch = UsageBatch {
            id: batch_id,
            stream_id,
            seller: seller.clone(),
            merkle_root: merkle_root.clone(),
            call_count,
            first_call_index,
            charged: charge,
            voided_calls: 0,
            refunded: 0,
            recorded_at: env.ledger().timestamp(),
            status: BatchStatus::Recorded,
        };
        save_batch(&env, &batch);

        env.events().publish(
            (Symbol::new(&env, "USAGE_BATCH_RECORDED"), seller),
            (stream_id, batch_id, merkle_root, call_count, charge),
        );

        batch_id
    }

    /// Pay out a batch, once its challenge window has closed.
    ///
    /// Per batch rather than per stream so one disputed batch cannot hold an
    /// honest seller's other batches hostage.
    pub fn claim_usage_batch(env: Env, seller: Address, stream_id: u64, batch_id: u64) -> i128 {
        seller.require_auth();

        let stream = load_stream(&env, stream_id);
        assert!(stream.recipient == seller, "not the stream recipient");

        let mut batch = load_batch(&env, stream_id, batch_id);
        assert!(batch.seller == seller, "not the batch seller");
        assert!(
            batch.status != BatchStatus::Claimed,
            "batch already claimed"
        );
        assert!(
            env.ledger().timestamp() >= batch.recorded_at + CHALLENGE_WINDOW_SECS,
            "challenge window is still open"
        );

        let payable = batch.charged - batch.refunded;
        batch.status = BatchStatus::Claimed;
        save_batch(&env, &batch);

        if payable <= 0 {
            // Fully voided: nothing to pay, but the batch is closed out so it
            // cannot be re-challenged or re-claimed.
            return 0;
        }

        let mut meter = load_meter(&env, stream_id);
        meter.charged -= payable;
        meter.claimed += payable;
        save_meter(&env, stream_id, &meter);

        let token_client = token::Client::new(&env, &stream.token);
        token_client.transfer(&env.current_contract_address(), &seller, &payable);

        env.events().publish(
            (Symbol::new(&env, "USAGE_BATCH_CLAIMED"), seller),
            (stream_id, batch_id, payable),
        );

        payable
    }

    // ── Buyer: disputes ──────────────────────────────────────────────────────

    /// Dispute one attestation inside a committed batch.
    ///
    /// The buyer supplies the leaf they contest plus the sibling hashes tying
    /// it to the committed root. Two things then have to be true for the
    /// challenge to succeed:
    ///
    ///   - the proof re-derives the batch's committed root, so the seller
    ///     really did commit to this exact leaf, and
    ///   - the leaf's signature does *not* verify under the seller's registered
    ///     key, so the seller committed to something they never signed.
    ///
    /// A proof that does not reach the root is rejected outright. A leaf that
    /// *does* verify means the buyer challenged an honest call, and the call
    /// panics rather than voiding anything.
    ///
    /// Returns how many calls this challenge newly voided.
    pub fn challenge_usage_batch(
        env: Env,
        buyer: Address,
        stream_id: u64,
        batch_id: u64,
        disputed_leaf: AttestationLeaf,
        merkle_proof: Vec<BytesN<32>>,
    ) -> u64 {
        buyer.require_auth();

        let stream = load_stream(&env, stream_id);
        assert!(stream.sender == buyer, "not the stream sender");
        assert!(
            disputed_leaf.stream_id == stream_id,
            "leaf belongs to a different stream"
        );

        let mut batch = load_batch(&env, stream_id, batch_id);
        assert!(
            batch.status != BatchStatus::Claimed,
            "batch already claimed; the challenge window has closed"
        );
        assert!(
            env.ledger().timestamp() < batch.recorded_at + CHALLENGE_WINDOW_SECS,
            "challenge window has closed"
        );

        // 1. Is this leaf actually under the committed root?
        let leaf = leaf_hash(&env, &disputed_leaf);
        let derived_root = root_from_proof(&env, &leaf, &merkle_proof);
        assert!(
            derived_root == batch.merkle_root,
            "merkle proof does not reproduce the committed root"
        );

        // 2. Did the seller sign it? If they did, the batch stands.
        let public_key: BytesN<32> = env
            .storage()
            .persistent()
            .get(&AttKey::SellerKey(batch.seller.clone()))
            .expect("seller has no registered attestation key");

        let signed = signature_is_valid(
            &env,
            &public_key,
            &leaf_message(&env, &disputed_leaf),
            &disputed_leaf.signature,
        );
        assert!(
            !signed,
            "attestation is validly signed; nothing to challenge"
        );

        let position = position_in_batch(&batch, &disputed_leaf);
        let mut meter = load_meter(&env, stream_id);
        let newly_voided = void_suffix(&mut batch, &mut meter, position);

        save_meter(&env, stream_id, &meter);
        save_batch(&env, &batch);

        env.events().publish(
            (Symbol::new(&env, "USAGE_BATCH_VOIDED"), buyer),
            (
                stream_id,
                batch_id,
                disputed_leaf.call_index,
                newly_voided,
                batch.refunded,
            ),
        );

        newly_voided
    }

    /// Dispute a nonce replayed across two committed batches.
    ///
    /// A reused nonce needs no signature check to be damning: both leaves are
    /// provably committed, and both carry the same nonce, which an honest
    /// seller never emits twice on one stream. The *later* leaf is the
    /// fraudulent one, so its batch takes the void.
    ///
    /// This is a second entrypoint rather than a branch inside
    /// `challenge_usage_batch` because proving replay takes two leaves and two
    /// proofs, and folding them into a signature whose shape says "one disputed
    /// leaf" would make both paths harder to read.
    pub fn challenge_nonce_replay(
        env: Env,
        buyer: Address,
        stream_id: u64,
        original_batch_id: u64,
        original_leaf: AttestationLeaf,
        original_proof: Vec<BytesN<32>>,
        replay_batch_id: u64,
        replay_leaf: AttestationLeaf,
        replay_proof: Vec<BytesN<32>>,
    ) -> u64 {
        buyer.require_auth();

        let stream = load_stream(&env, stream_id);
        assert!(stream.sender == buyer, "not the stream sender");
        assert!(
            original_leaf.stream_id == stream_id && replay_leaf.stream_id == stream_id,
            "leaves belong to a different stream"
        );
        assert!(
            original_leaf.nonce == replay_leaf.nonce,
            "leaves do not share a nonce; nothing was replayed"
        );
        assert!(
            original_leaf.call_index != replay_leaf.call_index,
            "both leaves are the same call"
        );
        assert!(
            original_leaf.call_index < replay_leaf.call_index,
            "the replay must be the later call"
        );

        // Both leaves must really be committed — otherwise a buyer could invent
        // a "duplicate" out of thin air.
        let original_batch = load_batch(&env, stream_id, original_batch_id);
        let original_hash = leaf_hash(&env, &original_leaf);
        assert!(
            root_from_proof(&env, &original_hash, &original_proof) == original_batch.merkle_root,
            "original leaf is not committed in its batch"
        );

        let mut replay_batch = load_batch(&env, stream_id, replay_batch_id);
        assert!(
            replay_batch.status != BatchStatus::Claimed,
            "batch already claimed; the challenge window has closed"
        );
        assert!(
            env.ledger().timestamp() < replay_batch.recorded_at + CHALLENGE_WINDOW_SECS,
            "challenge window has closed"
        );

        let replay_hash = leaf_hash(&env, &replay_leaf);
        assert!(
            root_from_proof(&env, &replay_hash, &replay_proof) == replay_batch.merkle_root,
            "replayed leaf is not committed in its batch"
        );

        let position = position_in_batch(&replay_batch, &replay_leaf);
        let mut meter = load_meter(&env, stream_id);
        let newly_voided = void_suffix(&mut replay_batch, &mut meter, position);

        save_meter(&env, stream_id, &meter);
        save_batch(&env, &replay_batch);

        env.events().publish(
            (Symbol::new(&env, "USAGE_NONCE_REPLAYED"), buyer),
            (
                stream_id,
                replay_batch_id,
                replay_leaf.call_index,
                newly_voided,
            ),
        );

        newly_voided
    }

    // ── Views ────────────────────────────────────────────────────────────────

    pub fn get_usage_meter(env: Env, stream_id: u64) -> Option<UsageMeter> {
        env.storage().persistent().get(&AttKey::Meter(stream_id))
    }

    pub fn get_usage_batch(env: Env, stream_id: u64, batch_id: u64) -> Option<UsageBatch> {
        env.storage()
            .persistent()
            .get(&AttKey::Batch(stream_id, batch_id))
    }

    /// How many more calls the buyer's escrowed allowance covers.
    pub fn usage_calls_remaining(env: Env, stream_id: u64) -> u64 {
        match env
            .storage()
            .persistent()
            .get::<AttKey, UsageMeter>(&AttKey::Meter(stream_id))
        {
            Some(meter) if meter.price_per_call > 0 => (meter.escrowed / meter.price_per_call) as u64,
            _ => 0,
        }
    }

    /// Check a Merkle proof without spending anything — the read-only twin of
    /// the first half of `challenge_usage_batch`, so a buyer can confirm their
    /// proof is well-formed before paying to submit it.
    pub fn verify_usage_proof(
        env: Env,
        stream_id: u64,
        batch_id: u64,
        leaf: AttestationLeaf,
        merkle_proof: Vec<BytesN<32>>,
    ) -> bool {
        match env
            .storage()
            .persistent()
            .get::<AttKey, UsageBatch>(&AttKey::Batch(stream_id, batch_id))
        {
            Some(batch) => {
                let hash = leaf_hash(&env, &leaf);
                root_from_proof(&env, &hash, &merkle_proof) == batch.merkle_root
            }
            None => false,
        }
    }

    /// The leaf hash for an attestation, exposed so an off-chain verifier can
    /// confirm it derives leaves the same way the contract does.
    pub fn attestation_leaf_hash(env: Env, leaf: AttestationLeaf) -> BytesN<32> {
        leaf_hash(&env, &leaf)
    }
}
