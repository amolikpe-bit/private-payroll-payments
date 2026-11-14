//! Unit tests for the subrosa contract.
//!
//! Every test runs against `near_sdk::test_utils` (host VM context); no sandbox
//! and no network access is required. The Groth16 fixture in
//! `testdata/groth16/multiplier2/` is a real snarkjs proof (public input `33`)
//! generated from the circom `multiplier2` circuit; see the fixture README.

use std::any::Any;

use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::{VMContextBuilder, get_logs};
use near_sdk::{AccountId, NearToken, env, testing_env};

use crate::events::Event;
use crate::groth16::{
    field_neg, g1_neg, parse_decimal_fr, parse_decimal_u256, validate_verification_key,
};
use crate::{
    COMMITMENT_RECORD_BYTES, CommitItem, Contract, EMPLOYEE_RECORD_BYTES, GRACE_NS,
    HOLD_RECORD_BYTES, HoldReason, HoldScope, HoldState, MAX_BATCH_COMMITS, NULLIFIER_RECORD_BYTES,
    PAYOUT_RECORD_BYTES, PayoutState,
};

const NOW: u64 = 1_700_000_000_000_000_000;
const YOCTO_PER_BYTE: u128 = 10_000_000_000_000_000_000;

const PROOF_JSON: &str = include_str!("../testdata/groth16/multiplier2/proof.json");
const PUBLIC_JSON: &str = include_str!("../testdata/groth16/multiplier2/public.json");
const VK_JSON: &str = include_str!("../testdata/groth16/multiplier2/verification_key.json");

fn acct(name: &str) -> AccountId {
    name.parse().unwrap()
}

fn deposit(bytes: u64) -> NearToken {
    NearToken::from_yoctonear(YOCTO_PER_BYTE * u128::from(bytes))
}

fn zero() -> NearToken {
    NearToken::from_yoctonear(0)
}

/// Installs a VM context. Storage is preserved between calls (near-sdk takes
/// the trie from the previous mocked blockchain).
fn set_context(caller: &str, attached: NearToken, timestamp: u64) {
    testing_env!(
        VMContextBuilder::new()
            .predecessor_account_id(acct(caller))
            .block_timestamp(timestamp)
            .attached_deposit(attached)
            .build()
    );
}

/// Builds a contract on a fresh mocked trie, so tests stay isolated even when
/// the harness reuses a thread.
fn setup() -> Contract {
    set_context("owner.near", zero(), NOW);
    near_sdk::mock::with_mocked_blockchain(|blockchain| {
        blockchain.take_storage();
    });
    Contract::new(acct("owner.near"))
}

fn hex64(seed: u8) -> String {
    format!("{:02x}", seed).repeat(32)
}

fn register(contract: &mut Contract, employer: &str, employee: &str, commitment: &str) {
    set_context(
        employer,
        deposit(EMPLOYEE_RECORD_BYTES + "employee".len() as u64),
        NOW,
    );
    contract.register_employee(
        acct(employee),
        commitment.to_string(),
        acct("usdc.near"),
        "employee".to_string(),
    );
}

fn commit(contract: &mut Contract, employer: &str, employee: &str, hash: &str, cycle_id: u64) {
    set_context(employer, deposit(COMMITMENT_RECORD_BYTES), NOW);
    contract.commit_salary(acct(employee), hash.to_string(), cycle_id);
}

fn schedule(contract: &mut Contract, employer: &str, employee: &str, execute_at: u64) -> u64 {
    set_context(
        employer,
        deposit(PAYOUT_RECORD_BYTES + "november".len() as u64),
        NOW,
    );
    contract.schedule_payout(
        acct(employee),
        hex64(9),
        acct("usdc.near"),
        "november".to_string(),
        execute_at,
    )
}

fn panic_message(payload: Box<dyn Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else if let Some(message) = payload.downcast_ref::<&str>() {
        (*message).to_string()
    } else {
        String::new()
    }
}

fn decode_hex(value: &str) -> Vec<u8> {
    let bytes = value.as_bytes();
    assert_eq!(bytes.len() % 2, 0, "hex must be even length");
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for pair in bytes.chunks_exact(2) {
        let high = (pair[0] as char).to_digit(16).expect("hex high nibble");
        let low = (pair[1] as char).to_digit(16).expect("hex low nibble");
        out.push(((high << 4) | low) as u8);
    }
    out
}

// Fixtures

fn fixture_json(text: &str) -> Value {
    serde_json::from_str(text).expect("fixture is valid JSON")
}

fn json_decimal(value: &Value) -> [u8; 32] {
    parse_decimal_u256(value.as_str().expect("decimal string"))
        .expect("fixture value fits in 256 bits")
}

fn json_g1(value: &Value) -> Vec<u8> {
    let coordinates = value.as_array().expect("G1 array");
    let mut out = Vec::with_capacity(64);
    out.extend_from_slice(&json_decimal(&coordinates[0]));
    out.extend_from_slice(&json_decimal(&coordinates[1]));
    out
}

fn json_g2(value: &Value) -> Vec<u8> {
    let coordinates = value.as_array().expect("G2 array");
    let x = coordinates[0].as_array().expect("G2 x Fq2");
    let y = coordinates[1].as_array().expect("G2 y Fq2");
    let mut out = Vec::with_capacity(128);
    out.extend_from_slice(&json_decimal(&x[0])); // real
    out.extend_from_slice(&json_decimal(&x[1])); // imaginary
    out.extend_from_slice(&json_decimal(&y[0])); // real
    out.extend_from_slice(&json_decimal(&y[1])); // imaginary
    out
}

fn fixture_proof_bytes() -> Vec<u8> {
    let proof = fixture_json(PROOF_JSON);
    let mut out = Vec::with_capacity(256);
    out.extend_from_slice(&json_g1(&proof["pi_a"]));
    out.extend_from_slice(&json_g2(&proof["pi_b"]));
    out.extend_from_slice(&json_g1(&proof["pi_c"]));
    out
}

fn fixture_proof_a() -> [u8; 64] {
    json_g1(&fixture_json(PROOF_JSON)["pi_a"])
        .try_into()
        .unwrap()
}

fn fixture_vk_bytes() -> Vec<u8> {
    let vk = fixture_json(VK_JSON);
    let mut out = Vec::new();
    out.extend_from_slice(&json_g1(&vk["vk_alpha_1"]));
    out.extend_from_slice(&json_g2(&vk["vk_beta_2"]));
    out.extend_from_slice(&json_g2(&vk["vk_gamma_2"]));
    out.extend_from_slice(&json_g2(&vk["vk_delta_2"]));
    let ic = vk["IC"].as_array().expect("IC array");
    out.extend_from_slice(&(ic.len() as u32).to_le_bytes());
    for point in ic {
        out.extend_from_slice(&json_g1(point));
    }
    out
}

fn fixture_public_inputs() -> Vec<String> {
    fixture_json(PUBLIC_JSON)
        .as_array()
        .expect("public array")
        .iter()
        .map(|value| value.as_str().expect("decimal string").to_string())
        .collect()
}

// Init, pause, owner

#[test]
fn new_contract_starts_unpaused_with_empty_indexes() {
    let contract = setup();
    assert_eq!(contract.get_verification_key_count(), 0);
    assert_eq!(contract.get_active_verification_key_id(), 0);
    assert_eq!(contract.get_payout_count(acct("acme.near")), 0);
    assert_eq!(contract.get_employee_count(acct("acme.near")), 0);
}

#[test]
#[should_panic(expected = "Owner only")]
fn set_pause_requires_owner() {
    let mut contract = setup();
    set_context("acme.near", zero(), NOW);
    contract.set_pause(true);
}

#[test]
fn owner_can_pause_and_unpause() {
    let mut contract = setup();
    set_context("owner.near", zero(), NOW);
    contract.set_pause(true);
    contract.set_pause(true); // idempotent
    contract.set_pause(false);

    register(&mut contract, "acme.near", "alice.near", &hex64(1));
    assert!(contract.employee_exists(acct("acme.near"), acct("alice.near")));
}

#[test]
#[should_panic(expected = "Disallowed while contract is paused")]
fn writes_are_rejected_while_paused() {
    let mut contract = setup();
    set_context("owner.near", zero(), NOW);
    contract.set_pause(true);

    set_context("acme.near", deposit(EMPLOYEE_RECORD_BYTES), NOW);
    contract.register_employee(
        acct("alice.near"),
        hex64(1),
        acct("usdc.near"),
        "employee".to_string(),
    );
}

// Registry

#[test]
fn register_employee_stores_row_and_emits_event() {
    let mut contract = setup();
    register(&mut contract, "acme.near", "alice.near", &hex64(1));

    let entry = contract
        .get_employee(acct("acme.near"), acct("alice.near"))
        .expect("registered");
    assert_eq!(entry.salary_commitment, hex64(1));
    assert_eq!(entry.token, acct("usdc.near"));
    assert_eq!(entry.metadata, "employee");
    assert!(entry.active);
    assert_eq!(entry.created_at, NOW);
    assert_eq!(entry.updated_at, NOW);
    assert_eq!(contract.get_employee_count(acct("acme.near")), 1);
    assert!(contract.employee_exists(acct("acme.near"), acct("alice.near")));
    assert!(
        contract
            .get_employee(acct("acme.near"), acct("bob.near"))
            .is_none()
    );

    let log = get_logs()
        .into_iter()
        .find(|line| line.contains("employee_registered"))
        .expect("employee_registered event");
    assert!(log.contains("\"standard\":\"subrosa\""));
    assert!(log.contains("\"version\":\"1.0.0\""));
    assert!(log.contains("\"at_ns\":1700000000000000000"));
}

#[test]
#[should_panic(expected = "Requires attached deposit")]
fn register_employee_requires_storage_deposit() {
    let mut contract = setup();
    set_context("acme.near", zero(), NOW);
    contract.register_employee(
        acct("alice.near"),
        hex64(1),
        acct("usdc.near"),
        "employee".to_string(),
    );
}

#[test]
#[should_panic(expected = "64 lowercase hexadecimal")]
fn register_employee_rejects_uppercase_hash() {
    let mut contract = setup();
    set_context("acme.near", deposit(EMPLOYEE_RECORD_BYTES), NOW);
    contract.register_employee(
        acct("alice.near"),
        "AB".repeat(32),
        acct("usdc.near"),
        "employee".to_string(),
    );
}

#[test]
#[should_panic(expected = "Employee already registered")]
fn register_employee_rejects_duplicate() {
    let mut contract = setup();
    register(&mut contract, "acme.near", "alice.near", &hex64(1));
    register(&mut contract, "acme.near", "alice.near", &hex64(2));
}

#[test]
fn update_and_deactivate_employee() {
    let mut contract = setup();
    register(&mut contract, "acme.near", "alice.near", &hex64(1));

    set_context("acme.near", zero(), NOW + 10);
    contract.update_employee(acct("alice.near"), hex64(2));
    let entry = contract
        .get_employee(acct("acme.near"), acct("alice.near"))
        .unwrap();
    assert_eq!(entry.salary_commitment, hex64(2));
    assert_eq!(entry.created_at, NOW);
    assert_eq!(entry.updated_at, NOW + 10);
    assert!(entry.active);

    set_context("acme.near", zero(), NOW + 20);
    contract.deactivate_employee(acct("alice.near"));
    let entry = contract
        .get_employee(acct("acme.near"), acct("alice.near"))
        .unwrap();
    assert!(!entry.active);
    assert_eq!(entry.updated_at, NOW + 20);
    assert_eq!(contract.get_employee_count(acct("acme.near")), 1);
}

#[test]
fn get_employees_paginates_and_past_end_is_empty() {
    let mut contract = setup();
    register(&mut contract, "acme.near", "alice.near", &hex64(1));
    register(&mut contract, "acme.near", "bob.near", &hex64(2));
    register(&mut contract, "acme.near", "carol.near", &hex64(3));

    assert_eq!(
        contract.get_employees(acct("acme.near"), 0, 2),
        vec![acct("alice.near"), acct("bob.near")]
    );
    assert_eq!(
        contract.get_employees(acct("acme.near"), 1, 1),
        vec![acct("bob.near")]
    );
    assert!(contract.get_employees(acct("acme.near"), 10, 10).is_empty());
}

#[test]
#[should_panic(expected = "limit must be between 1 and 500")]
fn get_employees_rejects_out_of_range_limit() {
    let contract = setup();
    contract.get_employees(acct("acme.near"), 0, 0);
}

// Commitments

#[test]
fn commit_salary_upserts_and_tracks_distinct_cycles() {
    let mut contract = setup();
    register(&mut contract, "acme.near", "alice.near", &hex64(1));

    commit(&mut contract, "acme.near", "alice.near", &hex64(2), 7);
    let entry = contract
        .get_commitment(acct("acme.near"), acct("alice.near"), 7)
        .expect("commitment");
    assert_eq!(entry.commitment_hash, hex64(2));
    assert_eq!(entry.token, acct("usdc.near"));
    assert_eq!(entry.created_at, NOW);
    assert_eq!(
        contract.get_commitment_count(acct("acme.near"), acct("alice.near")),
        1
    );

    commit(&mut contract, "acme.near", "alice.near", &hex64(3), 7);
    let entry = contract
        .get_commitment(acct("acme.near"), acct("alice.near"), 7)
        .unwrap();
    assert_eq!(entry.commitment_hash, hex64(3));
    assert_eq!(entry.created_at, NOW);
    assert_eq!(
        contract.get_commitment_count(acct("acme.near"), acct("alice.near")),
        1
    );

    commit(&mut contract, "acme.near", "alice.near", &hex64(4), 8);
    assert_eq!(
        contract.get_commitment_count(acct("acme.near"), acct("alice.near")),
        2
    );
}

#[test]
#[should_panic(expected = "Employee not registered")]
fn commit_salary_requires_registered_employee() {
    let mut contract = setup();
    set_context("acme.near", deposit(COMMITMENT_RECORD_BYTES), NOW);
    contract.commit_salary(acct("alice.near"), hex64(2), 1);
}

#[test]
fn batch_commit_stores_all_items() {
    let mut contract = setup();
    register(&mut contract, "acme.near", "alice.near", &hex64(1));
    register(&mut contract, "acme.near", "bob.near", &hex64(2));

    set_context("acme.near", deposit(2 * COMMITMENT_RECORD_BYTES), NOW);
    contract.batch_commit_salaries(vec![
        CommitItem {
            employee: acct("alice.near"),
            commitment_hash: hex64(3),
            cycle_id: 1,
        },
        CommitItem {
            employee: acct("bob.near"),
            commitment_hash: hex64(4),
            cycle_id: 1,
        },
    ]);

    assert_eq!(
        contract
            .get_commitment(acct("acme.near"), acct("alice.near"), 1)
            .unwrap()
            .commitment_hash,
        hex64(3)
    );
    assert_eq!(
        contract
            .get_commitment(acct("acme.near"), acct("bob.near"), 1)
            .unwrap()
            .commitment_hash,
        hex64(4)
    );
    assert!(
        get_logs()
            .iter()
            .any(|line| line.contains("salary_committed"))
    );
}

#[test]
#[should_panic(expected = "Batch exceeds the 50 commit cap")]
fn batch_commit_enforces_cap() {
    let mut contract = setup();
    let items: Vec<CommitItem> = (0..=MAX_BATCH_COMMITS)
        .map(|index| CommitItem {
            employee: acct(&format!("employee{}.near", index)),
            commitment_hash: hex64(1),
            cycle_id: 1,
        })
        .collect();
    set_context("acme.near", deposit(COMMITMENT_RECORD_BYTES * 51), NOW);
    contract.batch_commit_salaries(items);
}

#[test]
#[should_panic(expected = "Requires attached deposit")]
fn batch_commit_requires_storage_deposit() {
    let mut contract = setup();
    set_context("acme.near", zero(), NOW);
    contract.batch_commit_salaries(vec![CommitItem {
        employee: acct("alice.near"),
        commitment_hash: hex64(1),
        cycle_id: 1,
    }]);
}

// Payout lifecycle

#[test]
fn schedule_payout_assigns_one_based_ids() {
    let mut contract = setup();
    register(&mut contract, "acme.near", "alice.near", &hex64(1));

    let first = schedule(&mut contract, "acme.near", "alice.near", NOW + 100);
    assert_eq!(first, 1);
    let second = schedule(&mut contract, "acme.near", "alice.near", NOW + 200);
    assert_eq!(second, 2);
    assert_eq!(contract.get_payout_count(acct("acme.near")), 2);

    let payout = contract
        .get_payout(acct("acme.near"), first)
        .expect("payout");
    assert_eq!(payout.employer, acct("acme.near"));
    assert_eq!(payout.employee, acct("alice.near"));
    assert_eq!(payout.commitment_hash, hex64(9));
    assert_eq!(payout.asset, acct("usdc.near"));
    assert_eq!(payout.memo, "november");
    assert_eq!(payout.execute_at, NOW + 100);
    assert_eq!(payout.created_at, NOW);
    assert_eq!(payout.state, PayoutState::Pending);
    assert_eq!(payout.intent_hash, None);
    assert!(!contract.is_payout_due(acct("acme.near"), first));

    let pending = contract.get_pending_payouts(acct("acme.near"), 0, 10);
    assert_eq!(pending.len(), 2);
    let page = contract.get_pending_payouts(acct("acme.near"), 1, 10);
    assert_eq!(page.len(), 1);
    assert_eq!(page[0].employee, acct("alice.near"));
    assert!(
        contract
            .get_pending_payouts(acct("acme.near"), 10, 10)
            .is_empty()
    );
}

#[test]
#[should_panic(expected = "Requires attached deposit")]
fn schedule_payout_requires_storage_deposit() {
    let mut contract = setup();
    register(&mut contract, "acme.near", "alice.near", &hex64(1));
    set_context("acme.near", zero(), NOW);
    contract.schedule_payout(
        acct("alice.near"),
        hex64(9),
        acct("usdc.near"),
        "november".to_string(),
        NOW + 100,
    );
}

#[test]
fn cancel_payout_moves_pending_to_cancelled() {
    let mut contract = setup();
    register(&mut contract, "acme.near", "alice.near", &hex64(1));
    let payout_id = schedule(&mut contract, "acme.near", "alice.near", NOW + 100);

    set_context("acme.near", zero(), NOW);
    contract.cancel_payout(payout_id, "duplicate_run".to_string());
    let payout = contract.get_payout(acct("acme.near"), payout_id).unwrap();
    assert_eq!(payout.state, PayoutState::Cancelled);
    assert!(
        contract
            .get_pending_payouts(acct("acme.near"), 0, 10)
            .is_empty()
    );
    assert!(!contract.is_payout_due(acct("acme.near"), payout_id));
}

#[test]
#[should_panic(expected = "Payout is not pending")]
fn cancel_payout_rejects_settled_state() {
    let mut contract = setup();
    register(&mut contract, "acme.near", "alice.near", &hex64(1));
    let payout_id = schedule(&mut contract, "acme.near", "alice.near", NOW + 100);

    set_context("acme.near", zero(), NOW);
    contract.cancel_payout(payout_id, "other".to_string());
    contract.cancel_payout(payout_id, "other".to_string());
}

#[test]
#[should_panic(expected = "Unsupported cancellation reason code")]
fn cancel_payout_rejects_unknown_reason() {
    let mut contract = setup();
    register(&mut contract, "acme.near", "alice.near", &hex64(1));
    let payout_id = schedule(&mut contract, "acme.near", "alice.near", NOW + 100);

    set_context("acme.near", zero(), NOW);
    contract.cancel_payout(payout_id, "user_requested".to_string());
}

#[test]
fn mark_settled_records_intent_hash() {
    let mut contract = setup();
    register(&mut contract, "acme.near", "alice.near", &hex64(1));
    let payout_id = schedule(&mut contract, "acme.near", "alice.near", NOW + 100);

    let intent_hash = hex64(7);
    set_context("acme.near", zero(), NOW);
    contract.mark_settled(payout_id, intent_hash.clone());
    let payout = contract.get_payout(acct("acme.near"), payout_id).unwrap();
    assert_eq!(payout.state, PayoutState::Executed);
    assert_eq!(payout.intent_hash, Some(intent_hash));
    assert!(
        contract
            .get_pending_payouts(acct("acme.near"), 0, 10)
            .is_empty()
    );
}

#[test]
#[should_panic(expected = "intent_hash must be 32-88 base58 characters")]
fn mark_settled_rejects_short_hash() {
    let mut contract = setup();
    register(&mut contract, "acme.near", "alice.near", &hex64(1));
    let payout_id = schedule(&mut contract, "acme.near", "alice.near", NOW + 100);

    set_context("acme.near", zero(), NOW);
    contract.mark_settled(payout_id, "too-short".to_string());
}

#[test]
fn mark_failed_accepts_refunded() {
    let mut contract = setup();
    register(&mut contract, "acme.near", "alice.near", &hex64(1));
    let payout_id = schedule(&mut contract, "acme.near", "alice.near", NOW + 100);

    set_context("acme.near", zero(), NOW);
    contract.mark_failed(payout_id, "REFUNDED".to_string());
    let payout = contract.get_payout(acct("acme.near"), payout_id).unwrap();
    assert_eq!(payout.state, PayoutState::Failed);
    assert_eq!(payout.intent_hash, None);
}

#[test]
#[should_panic(expected = "status must be FAILED or REFUNDED")]
fn mark_failed_rejects_non_terminal_status() {
    let mut contract = setup();
    register(&mut contract, "acme.near", "alice.near", &hex64(1));
    let payout_id = schedule(&mut contract, "acme.near", "alice.near", NOW + 100);

    set_context("acme.near", zero(), NOW);
    contract.mark_failed(payout_id, "SUCCESS".to_string());
}

#[test]
fn expire_payout_respects_grace_period() {
    let mut contract = setup();
    register(&mut contract, "acme.near", "alice.near", &hex64(1));
    let payout_id = schedule(&mut contract, "acme.near", "alice.near", NOW);

    set_context("acme.near", zero(), NOW + GRACE_NS);
    assert!(contract.is_payout_due(acct("acme.near"), payout_id));
    contract.expire_payout(payout_id);
    let payout = contract.get_payout(acct("acme.near"), payout_id).unwrap();
    assert_eq!(payout.state, PayoutState::Expired);
    assert!(!contract.is_payout_due(acct("acme.near"), payout_id));
}

#[test]
#[should_panic(expected = "Payout cannot be expired yet")]
fn expire_payout_rejects_before_grace() {
    let mut contract = setup();
    register(&mut contract, "acme.near", "alice.near", &hex64(1));
    let payout_id = schedule(&mut contract, "acme.near", "alice.near", NOW);

    set_context("acme.near", zero(), NOW + GRACE_NS - 1);
    contract.expire_payout(payout_id);
}

// Holds and auditors

fn create_hold(contract: &mut Contract, caller: &str, employer: &str, hold_id: &str, reason: &str) {
    set_context(
        caller,
        deposit(HOLD_RECORD_BYTES + hold_id.len() as u64 + "alice.near".len() as u64),
        NOW,
    );
    contract.create_audit_hold(
        hold_id.to_string(),
        acct(employer),
        HoldScope::Employee,
        "alice.near".to_string(),
        reason.to_string(),
    );
}

#[test]
fn hold_lifecycle_as_employer() {
    let mut contract = setup();
    create_hold(
        &mut contract,
        "acme.near",
        "acme.near",
        "hold-1",
        "KYC_REVIEW_PENDING",
    );

    let hold = contract.get_audit_hold("hold-1".to_string()).expect("hold");
    assert_eq!(hold.employer, acct("acme.near"));
    assert_eq!(hold.scope, HoldScope::Employee);
    assert_eq!(hold.scope_id, "alice.near");
    assert_eq!(hold.reason_code, HoldReason::KycReviewPending);
    assert_eq!(hold.state, HoldState::Active);
    assert_eq!(hold.placed_by, acct("acme.near"));
    assert_eq!(hold.placed_at, NOW);
    assert_eq!(hold.released_by, None);
    assert_eq!(hold.release_reason, None);

    set_context("acme.near", zero(), NOW + 5);
    contract.release_audit_hold("hold-1".to_string(), "MANUAL_REVIEW_REQUESTED".to_string());
    let hold = contract.get_audit_hold("hold-1".to_string()).unwrap();
    assert_eq!(hold.state, HoldState::Released);
    assert_eq!(hold.released_by, Some(acct("acme.near")));
    assert_eq!(hold.released_at, Some(NOW + 5));
    assert_eq!(hold.release_reason, Some(HoldReason::ManualReviewRequested));
}

#[test]
fn hold_ids_are_enumerable() {
    let mut contract = setup();
    create_hold(
        &mut contract,
        "acme.near",
        "acme.near",
        "hold-1",
        "KYC_REVIEW_PENDING",
    );
    create_hold(&mut contract, "acme.near", "acme.near", "hold-2", "OTHER");

    let ids = contract.get_hold_ids(acct("acme.near"), 0, 10);
    assert_eq!(ids, vec!["hold-1".to_string(), "hold-2".to_string()]);
    assert_eq!(
        contract.get_hold_ids(acct("acme.near"), 1, 10),
        vec!["hold-2".to_string()]
    );
}

#[test]
fn auditor_can_place_and_release_holds() {
    let mut contract = setup();

    set_context("acme.near", zero(), NOW);
    contract.grant_auditor(acct("acme.near"), acct("auditor.near"));

    create_hold(
        &mut contract,
        "auditor.near",
        "acme.near",
        "hold-auditor",
        "SANCTIONS_SCREENING",
    );
    set_context("auditor.near", zero(), NOW + 9);
    contract.release_audit_hold("hold-auditor".to_string(), "OTHER".to_string());

    let hold = contract.get_audit_hold("hold-auditor".to_string()).unwrap();
    assert_eq!(hold.placed_by, acct("auditor.near"));
    assert_eq!(hold.released_by, Some(acct("auditor.near")));
    assert_eq!(hold.released_at, Some(NOW + 9));
}

#[test]
#[should_panic(expected = "Only the employer or an auditor can create a hold")]
fn hold_creation_requires_role() {
    let mut contract = setup();
    create_hold(
        &mut contract,
        "mallory.near",
        "acme.near",
        "hold-x",
        "OTHER",
    );
}

#[test]
fn owner_can_grant_auditor_for_any_employer() {
    let mut contract = setup();
    set_context("owner.near", zero(), NOW);
    contract.grant_auditor(acct("acme.near"), acct("auditor.near"));

    create_hold(
        &mut contract,
        "auditor.near",
        "acme.near",
        "hold-owner-grant",
        "TAX_WITHHOLDING_DISCREPANCY",
    );
    assert!(
        contract
            .get_audit_hold("hold-owner-grant".to_string())
            .is_some()
    );
}

#[test]
fn revoke_auditor_removes_hold_rights() {
    let mut contract = setup();
    set_context("acme.near", zero(), NOW);
    contract.grant_auditor(acct("acme.near"), acct("auditor.near"));
    contract.revoke_auditor(acct("acme.near"), acct("auditor.near"));

    set_context(
        "auditor.near",
        deposit(HOLD_RECORD_BYTES + "hold-revoked".len() as u64 + "acme.near".len() as u64),
        NOW,
    );
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        contract.create_audit_hold(
            "hold-revoked".to_string(),
            acct("acme.near"),
            HoldScope::Employer,
            "acme.near".to_string(),
            "OTHER".to_string(),
        );
    }));
    let payload = result.expect_err("revoked auditor must not place holds");
    assert!(panic_message(payload).contains("Only the employer or an auditor"));
}

#[test]
#[should_panic(expected = "Owner only")]
fn grant_auditor_requires_employer_or_owner() {
    let mut contract = setup();
    set_context("mallory.near", zero(), NOW);
    contract.grant_auditor(acct("acme.near"), acct("mallory.near"));
}

#[test]
fn hold_reason_codes_are_strict_and_complete() {
    let mut contract = setup();
    let cases = [
        ("KYC_REVIEW_PENDING", HoldReason::KycReviewPending),
        ("SANCTIONS_SCREENING", HoldReason::SanctionsScreening),
        (
            "TAX_WITHHOLDING_DISCREPANCY",
            HoldReason::TaxWithholdingDiscrepancy,
        ),
        (
            "REGULATORY_INVESTIGATION",
            HoldReason::RegulatoryInvestigation,
        ),
        (
            "DUPLICATE_PAYMENT_SUSPECTED",
            HoldReason::DuplicatePaymentSuspected,
        ),
        ("MANUAL_REVIEW_REQUESTED", HoldReason::ManualReviewRequested),
        ("OTHER", HoldReason::Other),
    ];
    for (index, (code, expected)) in cases.into_iter().enumerate() {
        let hold_id = format!("hold-reason-{}", index);
        create_hold(&mut contract, "acme.near", "acme.near", &hold_id, code);
        assert_eq!(
            contract.get_audit_hold(hold_id).unwrap().reason_code,
            expected
        );
    }
}

#[test]
#[should_panic(expected = "Unknown hold reason code")]
fn hold_reason_rejects_lowercase_code() {
    let mut contract = setup();
    create_hold(
        &mut contract,
        "acme.near",
        "acme.near",
        "hold-bad",
        "kyc_review_pending",
    );
}

// Groth16 verification keys and proofs

#[test]
fn verification_key_registry_is_owner_managed() {
    let mut contract = setup();
    let vk_bytes = fixture_vk_bytes();

    set_context("owner.near", zero(), NOW);
    let id = contract.add_verification_key(vk_bytes.clone(), "multiplier2".to_string());
    assert_eq!(id, 1);
    assert_eq!(contract.get_verification_key_count(), 1);
    assert_eq!(contract.get_active_verification_key_id(), 0);

    let info = contract.get_verification_key_info(id).expect("vk info");
    assert_eq!(info.description, "multiplier2");
    assert_eq!(info.key, vk_bytes);
    assert_eq!(contract.get_verification_key(id).expect("raw vk"), vk_bytes);
    assert!(contract.get_verification_key_info(2).is_none());
    assert!(contract.get_verification_key(2).is_none());

    contract.set_active_verification_key(id);
    assert_eq!(contract.get_active_verification_key_id(), id);
}

#[test]
#[should_panic(expected = "Owner only")]
fn add_verification_key_requires_owner() {
    let mut contract = setup();
    set_context("acme.near", zero(), NOW);
    contract.add_verification_key(fixture_vk_bytes(), "multiplier2".to_string());
}

#[test]
#[should_panic(expected = "Invalid verification key encoding")]
fn add_verification_key_rejects_bad_layout() {
    let mut contract = setup();
    set_context("owner.near", zero(), NOW);
    contract.add_verification_key(vec![0u8; 10], "broken".to_string());
}

#[test]
fn groth16_decimal_parser_and_negation() {
    let thirty_three = parse_decimal_fr("33").expect("valid scalar");
    assert_eq!(thirty_three[0], 33);
    assert!(thirty_three[1..].iter().all(|byte| *byte == 0));
    assert!(parse_decimal_fr("0").unwrap().iter().all(|byte| *byte == 0));
    assert!(parse_decimal_fr("").is_none());
    assert!(parse_decimal_fr("-1").is_none());
    assert!(parse_decimal_fr("1.5").is_none());
    assert!(parse_decimal_fr("12a").is_none());
    // 2^256 does not fit.
    assert!(
        parse_decimal_fr(
            "115792089237316195423570985008687907853269984665640564039457584007913129639936"
        )
        .is_none()
    );

    let zero = [0u8; 32];
    assert_eq!(field_neg(&zero), Some(zero));
    let one = parse_decimal_fr("1").unwrap();
    let minus_one = field_neg(&one).expect("p - 1");
    assert_eq!(minus_one[0], 0x46);
    assert_eq!(field_neg(&minus_one), Some(one));

    let a = fixture_proof_a();
    let neg_a = g1_neg(&a).expect("canonical G1");
    assert_eq!(g1_neg(&neg_a), Some(a));
}

#[test]
fn groth16_rejects_lengths_and_unknown_key() {
    let mut contract = setup();
    set_context("owner.near", zero(), NOW);
    let id = contract.add_verification_key(fixture_vk_bytes(), "multiplier2".to_string());

    // Unknown key returns false before touching the deposit.
    assert!(!contract.verify_proof(vec![0u8; 256], vec!["33".to_string()], 999));
    assert!(!validate_verification_key(&[0u8; 10]));

    set_context("acme.near", deposit(NULLIFIER_RECORD_BYTES), NOW);
    let proof = fixture_proof_bytes();
    // Wrong proof length.
    assert!(!contract.verify_proof(vec![0u8; 255], vec!["33".to_string()], id));
    // Non-decimal public input.
    assert!(!contract.verify_proof(proof.clone(), vec!["-33".to_string()], id));
    // Public input count does not match the key's IC length.
    assert!(!contract.verify_proof(proof, Vec::new(), id));
}

#[test]
fn groth16_fixture_proof_verifies_and_replay_is_rejected() {
    let mut contract = setup();
    set_context("owner.near", zero(), NOW);
    let id = contract.add_verification_key(fixture_vk_bytes(), "multiplier2".to_string());

    let proof = fixture_proof_bytes();
    let public_inputs = fixture_public_inputs();
    assert_eq!(public_inputs, vec!["33".to_string()]);

    set_context("acme.near", deposit(NULLIFIER_RECORD_BYTES), NOW);
    assert!(contract.verify_proof(proof.clone(), public_inputs.clone(), id));

    let nullifier = crate::hex_encode(&env::sha256(&proof));
    let log = get_logs()
        .into_iter()
        .find(|line| line.contains("proof_verified"))
        .expect("proof_verified event");
    assert!(log.contains(&nullifier));

    let replay = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        contract.verify_proof(proof, public_inputs, id)
    }));
    let payload = replay.expect_err("replay must be rejected");
    assert!(panic_message(payload).contains("ProofAlreadyUsed"));
}

#[test]
fn groth16_evm_order_rejected() {
    let mut contract = setup();
    set_context("owner.near", zero(), NOW);
    let id = contract.add_verification_key(fixture_vk_bytes(), "multiplier2".to_string());

    // EIP-197-style bytes swap the Fq2 real/imaginary halves of each G2 point.
    let mut evm_proof = fixture_proof_bytes();
    for start in [64usize, 128usize] {
        for index in 0..32 {
            evm_proof.swap(start + index, start + 32 + index);
        }
    }
    let public_inputs = fixture_public_inputs();
    set_context("acme.near", deposit(NULLIFIER_RECORD_BYTES), NOW);

    let rejected = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        contract.verify_proof(evm_proof, public_inputs.clone(), id)
    }));
    if let Ok(accepted) = rejected {
        assert!(!accepted, "EVM-order proof bytes must not verify");
    }

    // A rejected encoding must not consume the real proof's nullifier.
    let proof = fixture_proof_bytes();
    assert!(contract.verify_proof(proof, public_inputs, id));
}

#[test]
fn groth16_one_bit_flip_rejected() {
    let mut contract = setup();
    set_context("owner.near", zero(), NOW);
    let id = contract.add_verification_key(fixture_vk_bytes(), "multiplier2".to_string());

    let mut flipped = fixture_proof_bytes();
    flipped[0] ^= 1;
    let public_inputs = fixture_public_inputs();
    set_context("acme.near", deposit(NULLIFIER_RECORD_BYTES), NOW);
    let rejected = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        contract.verify_proof(flipped, public_inputs.clone(), id)
    }));
    if let Ok(accepted) = rejected {
        assert!(!accepted, "one-bit-flipped proof must not verify");
    }

    let proof = fixture_proof_bytes();
    assert!(contract.verify_proof(proof, public_inputs, id));
}

const TS_PREIMAGE_HEX: &str = "737562726f73612f636f6d6d69742f76310f000000737562726f73612e746573746e65740d000000616c6963652e746573746e657413000000757364632e746f6b656e732e746573746e65740700000000000000d20a3f4eeee073c3f60fe98e0100000020000000000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const TS_COMMITMENT: &str = "2352e17857723f925f4774a0eb12ffbe51f1f7d81c7ce075ed69927db9ce0485";

#[test]
fn commitment_preimage_matches_ts_vector() {
    set_context("owner.near", zero(), NOW);
    let preimage = decode_hex(TS_PREIMAGE_HEX);
    assert_eq!(crate::hex_encode(&env::sha256(&preimage)), TS_COMMITMENT);
}

// Events

#[test]
fn event_payloads_are_nep297() {
    let variants = [
        (Event::EmployeeRegistered(vec![]), "employee_registered"),
        (Event::EmployeeUpdated(vec![]), "employee_updated"),
        (Event::SalaryCommitted(vec![]), "salary_committed"),
        (Event::AuditorChanged(vec![]), "auditor_changed"),
        (Event::PayoutScheduled(vec![]), "payout_scheduled"),
        (Event::PayoutStateChanged(vec![]), "payout_state_changed"),
        (Event::AuditHoldChanged(vec![]), "audit_hold_changed"),
        (Event::ProofVerified(vec![]), "proof_verified"),
    ];
    for (event, expected_name) in variants {
        assert_eq!(event.standard().as_ref(), "subrosa");
        assert_eq!(event.version().as_ref(), "1.0.0");
        assert_eq!(event.event().as_ref(), expected_name);
        let json = event.to_json();
        assert_eq!(json["standard"], "subrosa");
        assert_eq!(json["version"], "1.0.0");
        assert_eq!(json["event"], expected_name);
        assert!(json["data"].is_array());
    }
}
