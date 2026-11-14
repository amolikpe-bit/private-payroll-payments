//! `near-workspaces` 0.24.0 integration tests for the subrosa contract.
//!
//! These tests exercise the deployed wasm against a local sandbox node
//! (nearcore 2.14.0, no RPC/network calls outside the sandbox). They are
//! serialized through [`TEST_LOCK`] so exactly one sandbox and one fast-forward
//! clock mutation are active at a time.
//!
//! # Prerequisite
//!
//! A wasm build of this crate must exist before the test binary runs. Build it
//! with cargo-near 0.23.0, which sets `--cfg near` and post-processes the wasm
//! for the nearcore runtime:
//!
//! ```text
//! cargo near build non-reproducible-wasm
//! ```
//!
//! Set `SUBROSA_CONTRACT_WASM` to point at a specific artifact. Otherwise the
//! test searches the workspace/contract cargo-near `target/near/<package>/`
//! layout. A plain `cargo build --target wasm32-unknown-unknown` artifact is
//! intentionally not picked up: without `--cfg near` and cargo-near's
//! `wasm-opt` pass it is not a deployable on-chain build.
//!
//! # Storage deposits
//!
//! Sandbox storage costs 1e19 yoctoNEAR per byte. The contract asserts the
//! documented record sizes (267 B employee + metadata, 182 B commitment,
//! 258 B payout + memo, 186 B hold + ids, 73 B nullifier); every payable call
//! below attaches exactly that amount, and a one-yocto-short call is asserted
//! to fail.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use near_sdk::AccountId;
use near_sdk::serde::de::DeserializeOwned;
use near_sdk::serde_json::{Value, json};
use near_workspaces::network::Sandbox;
use near_workspaces::result::{ExecutionFinalResult, ExecutionSuccess};
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use subrosa_contract::{
    COMMITMENT_RECORD_BYTES, CommitItem, CommitmentEntry, EMPLOYEE_RECORD_BYTES, EmployeeEntry,
    GRACE_NS, HOLD_RECORD_BYTES, HoldEntry, HoldReason, HoldScope, HoldState, MAX_BATCH_COMMITS,
    MAX_METADATA_BYTES, NULLIFIER_RECORD_BYTES, PAYOUT_RECORD_BYTES, PayoutEntry, PayoutState,
    VerificationKeyInfo,
};
use tokio::sync::{Mutex, MutexGuard};

/// Sandbox storage price: 1e19 yoctoNEAR per byte.
const YOCTO_PER_BYTE: u128 = 10_000_000_000_000_000_000;
/// Gas attached to ordinary writes; well above their measured cost.
const DEFAULT_GAS_TGAS: u64 = 100;
/// Gas attached to Groth16 verification (the pairing alone costs ~30 Tgas).
const VERIFY_GAS_TGAS: u64 = 300;

static TEST_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
static WASM: LazyLock<Vec<u8>> = LazyLock::new(load_wasm);

const PROOF_JSON: &str = include_str!("../testdata/groth16/multiplier2/proof.json");
const PUBLIC_JSON: &str = include_str!("../testdata/groth16/multiplier2/public.json");
const VK_JSON: &str = include_str!("../testdata/groth16/multiplier2/verification_key.json");

// Serialization and fixtures

async fn serial() -> MutexGuard<'static, ()> {
    TEST_LOCK.lock().await
}

struct Fixture {
    worker: Worker<Sandbox>,
    contract: Contract,
    owner: Account,
    employer: Account,
    other: Account,
}

async fn setup() -> Fixture {
    let worker = near_workspaces::sandbox()
        .await
        .expect("sandbox starts with the pinned nearcore binary");
    let contract = worker
        .dev_deploy(contract_wasm())
        .await
        .expect("contract wasm deploys");
    // `near-workspaces` funds every dev account with 100 NEAR from the sandbox
    // root, so the attached record deposits (a few milliNEAR each) are covered.
    let owner = worker
        .dev_create_account()
        .await
        .expect("owner account is created and funded");
    let employer = worker
        .dev_create_account()
        .await
        .expect("employer account is created and funded");
    let other = worker
        .dev_create_account()
        .await
        .expect("third-party account is created and funded");

    let init = contract
        .call("new")
        .args_json(json!({ "owner": owner.id().to_string() }))
        .gas(Gas::from_tgas(DEFAULT_GAS_TGAS))
        .transact()
        .await
        .expect("init transaction is accepted");
    expect_success(init);

    Fixture {
        worker,
        contract,
        owner,
        employer,
        other,
    }
}

fn push_target_candidates(candidates: &mut Vec<PathBuf>, target: &Path) {
    candidates.push(target.join("near").join("subrosa_contract.wasm"));
    candidates.push(target.join("near").join("subrosa-contract.wasm"));
    for package in ["subrosa_contract", "subrosa-contract"] {
        candidates.push(
            target
                .join("near")
                .join(package)
                .join("subrosa_contract.wasm"),
        );
    }
}

fn wasm_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(explicit) = std::env::var("SUBROSA_CONTRACT_WASM") {
        candidates.push(PathBuf::from(explicit));
    }

    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let workspace = manifest
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| manifest.clone());
    if let Ok(target) = std::env::var("CARGO_TARGET_DIR") {
        let target = PathBuf::from(target);
        let target = if target.is_absolute() {
            target
        } else {
            workspace.join(target)
        };
        push_target_candidates(&mut candidates, &target);
    }
    push_target_candidates(&mut candidates, &workspace.join("target"));
    push_target_candidates(&mut candidates, &manifest.join("target"));
    candidates
}

fn load_wasm() -> Vec<u8> {
    let candidates = wasm_candidates();
    for path in &candidates {
        if !path.is_file() {
            continue;
        }
        let bytes = std::fs::read(path)
            .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()));
        assert!(
            bytes.starts_with(b"\0asm"),
            "not a WebAssembly artifact: {}",
            path.display()
        );
        return bytes;
    }
    panic!(
        "subrosa contract wasm not found. Build it first with \
         `cargo near build non-reproducible-wasm`, or set \
         SUBROSA_CONTRACT_WASM. Searched: {candidates:?}"
    );
}

fn contract_wasm() -> &'static [u8] {
    WASM.as_slice()
}

// Call and assertion helpers

fn deposit_for(bytes: usize) -> NearToken {
    NearToken::from_yoctonear(YOCTO_PER_BYTE * bytes as u128)
}

fn one_less(amount: NearToken) -> NearToken {
    NearToken::from_yoctonear(amount.as_yoctonear() - 1)
}

fn zero() -> NearToken {
    NearToken::from_yoctonear(0)
}

fn employee_deposit(metadata: &str) -> NearToken {
    deposit_for(EMPLOYEE_RECORD_BYTES as usize + metadata.len())
}

fn commitment_deposit(count: usize) -> NearToken {
    deposit_for(COMMITMENT_RECORD_BYTES as usize * count)
}

fn payout_deposit(memo: &str) -> NearToken {
    deposit_for(PAYOUT_RECORD_BYTES as usize + memo.len())
}

fn hold_deposit(hold_id: &str, scope_id: &str) -> NearToken {
    deposit_for(HOLD_RECORD_BYTES as usize + hold_id.len() + scope_id.len())
}

fn nullifier_deposit() -> NearToken {
    deposit_for(NULLIFIER_RECORD_BYTES as usize)
}

fn commitment(seed: u8) -> String {
    format!("{seed:02x}").repeat(32)
}

fn account(name: &str) -> AccountId {
    name.parse().expect("valid account id")
}

async fn call_with(
    account: &Account,
    contract: &Contract,
    method: &str,
    args: Value,
    deposit: NearToken,
    gas: Gas,
) -> ExecutionFinalResult {
    account
        .call(contract.id(), method)
        .args_json(args)
        .deposit(deposit)
        .gas(gas)
        .transact()
        .await
        .unwrap_or_else(|error| panic!("call `{method}` was not accepted: {error:?}"))
}

async fn call(
    account: &Account,
    contract: &Contract,
    method: &str,
    args: Value,
) -> ExecutionFinalResult {
    call_with(
        account,
        contract,
        method,
        args,
        zero(),
        Gas::from_tgas(DEFAULT_GAS_TGAS),
    )
    .await
}

async fn view<T: DeserializeOwned>(contract: &Contract, method: &str, args: Value) -> T {
    let result = contract
        .view(method)
        .args_json(args)
        .await
        .unwrap_or_else(|error| panic!("view `{method}` failed: {error:?}"));
    let parsed = result.json::<T>();
    match parsed {
        Ok(value) => value,
        Err(error) => panic!(
            "view `{method}` returned unexpected JSON: {error:?}; raw: {:?}",
            result.result
        ),
    }
}

async fn expect_view_failure(contract: &Contract, method: &str, args: Value) {
    if let Ok(result) = contract.view(method).args_json(args).await {
        panic!(
            "expected view `{method}` to fail, but it returned: {:?}",
            result.result
        );
    }
}

fn expect_success(outcome: ExecutionFinalResult) -> ExecutionSuccess {
    if !outcome.is_success() {
        let failure = outcome.into_result().err().expect("failure value");
        panic!("expected a successful call; got: {failure:?}");
    }
    outcome.into_result().expect("successful execution")
}

fn expect_failure(outcome: ExecutionFinalResult, needle: &str) {
    if outcome.is_success() {
        panic!("expected a failed call containing `{needle}`, but it succeeded");
    }
    let failure = outcome.into_result().err().expect("failure value");
    let text = format!("{failure:?}");
    assert!(
        text.contains(needle),
        "expected failure containing `{needle}`, got: {text}"
    );
}

fn success_json<T: DeserializeOwned>(outcome: ExecutionFinalResult) -> T {
    expect_success(outcome)
        .json::<T>()
        .unwrap_or_else(|error| panic!("call returned unexpected JSON: {error:?}"))
}

async fn payout(fixture: &Fixture, payout_id: u64) -> PayoutEntry {
    view::<Option<PayoutEntry>>(
        &fixture.contract,
        "get_payout",
        json!({
            "employer": fixture.employer.id().to_string(),
            "payout_id": payout_id,
        }),
    )
    .await
    .expect("payout row exists")
}

async fn is_due(fixture: &Fixture, payout_id: u64) -> bool {
    view(
        &fixture.contract,
        "is_payout_due",
        json!({
            "employer": fixture.employer.id().to_string(),
            "payout_id": payout_id,
        }),
    )
    .await
}

async fn schedule(
    fixture: &Fixture,
    employee: &Account,
    hash: &str,
    memo: &str,
    execute_at: u64,
    deposit: NearToken,
) -> ExecutionFinalResult {
    call_with(
        &fixture.employer,
        &fixture.contract,
        "schedule_payout",
        json!({
            "employee": employee.id().to_string(),
            "commitment_hash": hash,
            "asset": "usdc.testnet",
            "memo": memo,
            "execute_at": execute_at,
        }),
        deposit,
        Gas::from_tgas(DEFAULT_GAS_TGAS),
    )
    .await
}

// Registry, commitments, paging, and pause

#[tokio::test]
async fn sandbox_registry_commitments_and_pause() {
    let _serial = serial().await;
    let fixture = setup().await;
    let token = account("usdc.testnet");

    let employee_a = fixture
        .worker
        .dev_create_account()
        .await
        .expect("employee a");
    let employee_b = fixture
        .worker
        .dev_create_account()
        .await
        .expect("employee b");
    let employee_c = fixture
        .worker
        .dev_create_account()
        .await
        .expect("employee c");
    let employee_d = fixture
        .worker
        .dev_create_account()
        .await
        .expect("employee d");

    let metadata = "payroll-2026-11";
    let storage_before = fixture
        .contract
        .view_account()
        .await
        .expect("contract account")
        .storage_usage;
    let register_a = call_with(
        &fixture.employer,
        &fixture.contract,
        "register_employee",
        json!({
            "employee": employee_a.id().to_string(),
            "salary_commitment": commitment(0xa1),
            "token": token.to_string(),
            "metadata": metadata,
        }),
        employee_deposit(metadata),
        Gas::from_tgas(DEFAULT_GAS_TGAS),
    )
    .await;
    let logs = register_a
        .logs()
        .iter()
        .map(|line| (*line).to_string())
        .collect::<Vec<_>>();
    expect_success(register_a);
    let storage_after = fixture
        .contract
        .view_account()
        .await
        .expect("contract account after registration")
        .storage_usage;
    let modelled_growth = EMPLOYEE_RECORD_BYTES as u64 + metadata.len() as u64;
    let actual_growth = storage_after.saturating_sub(storage_before);
    assert!(
        actual_growth <= modelled_growth,
        "employee record grew by {actual_growth} bytes; modelled {modelled_growth} bytes"
    );
    assert!(
        logs.iter()
            .any(|line| line.contains("EVENT_JSON:") && line.contains("employee_registered")),
        "registration emits employee_registered: {logs:?}"
    );

    let entry: EmployeeEntry = view::<Option<EmployeeEntry>>(
        &fixture.contract,
        "get_employee",
        json!({
            "employer": fixture.employer.id().to_string(),
            "employee": employee_a.id().to_string(),
        }),
    )
    .await
    .expect("employee a row");
    assert_eq!(entry.salary_commitment, commitment(0xa1));
    assert_eq!(entry.token, token);
    assert_eq!(entry.metadata, metadata);
    assert!(entry.active);
    assert!(entry.created_at > 0);
    assert_eq!(entry.updated_at, entry.created_at);

    let exists: bool = view(
        &fixture.contract,
        "employee_exists",
        json!({
            "employer": fixture.employer.id().to_string(),
            "employee": employee_a.id().to_string(),
        }),
    )
    .await;
    assert!(exists);

    let count: u32 = view(
        &fixture.contract,
        "get_employee_count",
        json!({ "employer": fixture.employer.id().to_string() }),
    )
    .await;
    assert_eq!(count, 1);

    // One yoctoNEAR short of the documented 267 B + metadata deposit reverts.
    expect_failure(
        call_with(
            &fixture.employer,
            &fixture.contract,
            "register_employee",
            json!({
                "employee": employee_b.id().to_string(),
                "salary_commitment": commitment(0xa2),
                "token": token.to_string(),
                "metadata": metadata,
            }),
            one_less(employee_deposit(metadata)),
            Gas::from_tgas(DEFAULT_GAS_TGAS),
        )
        .await,
        "Requires attached deposit",
    );
    expect_success(
        call_with(
            &fixture.employer,
            &fixture.contract,
            "register_employee",
            json!({
                "employee": employee_b.id().to_string(),
                "salary_commitment": commitment(0xa2),
                "token": token.to_string(),
                "metadata": metadata,
            }),
            employee_deposit(metadata),
            Gas::from_tgas(DEFAULT_GAS_TGAS),
        )
        .await,
    );

    // Duplicate registration, metadata cap, and hash validation.
    expect_failure(
        call_with(
            &fixture.employer,
            &fixture.contract,
            "register_employee",
            json!({
                "employee": employee_a.id().to_string(),
                "salary_commitment": commitment(0xa3),
                "token": token.to_string(),
                "metadata": metadata,
            }),
            employee_deposit(metadata),
            Gas::from_tgas(DEFAULT_GAS_TGAS),
        )
        .await,
        "Employee already registered",
    );
    let long_metadata = "m".repeat(MAX_METADATA_BYTES + 1);
    expect_failure(
        call_with(
            &fixture.employer,
            &fixture.contract,
            "register_employee",
            json!({
                "employee": employee_c.id().to_string(),
                "salary_commitment": commitment(0xa4),
                "token": token.to_string(),
                "metadata": long_metadata,
            }),
            employee_deposit(&long_metadata),
            Gas::from_tgas(DEFAULT_GAS_TGAS),
        )
        .await,
        "metadata must be at most 256 bytes",
    );
    expect_failure(
        call_with(
            &fixture.employer,
            &fixture.contract,
            "register_employee",
            json!({
                "employee": employee_c.id().to_string(),
                "salary_commitment": "A".repeat(64),
                "token": token.to_string(),
                "metadata": metadata,
            }),
            employee_deposit(metadata),
            Gas::from_tgas(DEFAULT_GAS_TGAS),
        )
        .await,
        "commitment hash must be exactly 64 lowercase hexadecimal characters",
    );
    expect_success(
        call_with(
            &fixture.employer,
            &fixture.contract,
            "register_employee",
            json!({
                "employee": employee_c.id().to_string(),
                "salary_commitment": commitment(0xa4),
                "token": token.to_string(),
                "metadata": metadata,
            }),
            employee_deposit(metadata),
            Gas::from_tgas(DEFAULT_GAS_TGAS),
        )
        .await,
    );

    // Registry index paging and limit bounds.
    let page: Vec<AccountId> = view(
        &fixture.contract,
        "get_employees",
        json!({
            "employer": fixture.employer.id().to_string(),
            "from_index": 0,
            "limit": 2,
        }),
    )
    .await;
    assert_eq!(page, vec![employee_a.id().clone(), employee_b.id().clone()]);
    let page: Vec<AccountId> = view(
        &fixture.contract,
        "get_employees",
        json!({
            "employer": fixture.employer.id().to_string(),
            "from_index": 2,
            "limit": 2,
        }),
    )
    .await;
    assert_eq!(page, vec![employee_c.id().clone()]);
    let page: Vec<AccountId> = view(
        &fixture.contract,
        "get_employees",
        json!({
            "employer": fixture.employer.id().to_string(),
            "from_index": 9,
            "limit": 2,
        }),
    )
    .await;
    assert!(page.is_empty());
    expect_view_failure(
        &fixture.contract,
        "get_employees",
        json!({
            "employer": fixture.employer.id().to_string(),
            "from_index": 0,
            "limit": 0,
        }),
    )
    .await;

    // Wrong-caller update/deactivate are rejected; the owner employer succeeds.
    expect_failure(
        call(
            &fixture.other,
            &fixture.contract,
            "update_employee",
            json!({
                "employee": employee_a.id().to_string(),
                "salary_commitment": commitment(0xa5),
            }),
        )
        .await,
        "Employee not registered",
    );
    expect_failure(
        call(
            &fixture.other,
            &fixture.contract,
            "deactivate_employee",
            json!({ "employee": employee_a.id().to_string() }),
        )
        .await,
        "Employee not registered",
    );
    expect_success(
        call(
            &fixture.employer,
            &fixture.contract,
            "update_employee",
            json!({
                "employee": employee_a.id().to_string(),
                "salary_commitment": commitment(0xa5),
            }),
        )
        .await,
    );
    let updated: EmployeeEntry = view::<Option<EmployeeEntry>>(
        &fixture.contract,
        "get_employee",
        json!({
            "employer": fixture.employer.id().to_string(),
            "employee": employee_a.id().to_string(),
        }),
    )
    .await
    .expect("employee a row after update");
    assert_eq!(updated.salary_commitment, commitment(0xa5));
    assert!(updated.updated_at >= entry.updated_at);

    // Single commitment: exact deposit, overwrite keeps count/created_at.
    expect_failure(
        call_with(
            &fixture.employer,
            &fixture.contract,
            "commit_salary",
            json!({
                "employee": employee_a.id().to_string(),
                "commitment_hash": commitment(0xb1),
                "cycle_id": 1,
            }),
            one_less(commitment_deposit(1)),
            Gas::from_tgas(DEFAULT_GAS_TGAS),
        )
        .await,
        "Requires attached deposit",
    );
    let commit_storage_before = fixture
        .contract
        .view_account()
        .await
        .expect("contract account before commit")
        .storage_usage;
    let commit_outcome = call_with(
        &fixture.employer,
        &fixture.contract,
        "commit_salary",
        json!({
            "employee": employee_a.id().to_string(),
            "commitment_hash": commitment(0xb1),
            "cycle_id": 1,
        }),
        commitment_deposit(1),
        Gas::from_tgas(DEFAULT_GAS_TGAS),
    )
    .await;
    let commitment_gas_burnt = commit_outcome.total_gas_burnt.as_gas();
    expect_success(commit_outcome);
    let commit_storage_after = fixture
        .contract
        .view_account()
        .await
        .expect("contract account after commit")
        .storage_usage;
    eprintln!(
        "W4_CAPTURE commitment_gas_burnt={commitment_gas_burnt} \
         commitment_storage_delta={}",
        commit_storage_after.saturating_sub(commit_storage_before)
    );
    let stored: CommitmentEntry = view::<Option<CommitmentEntry>>(
        &fixture.contract,
        "get_commitment",
        json!({
            "employer": fixture.employer.id().to_string(),
            "employee": employee_a.id().to_string(),
            "cycle_id": 1,
        }),
    )
    .await
    .expect("commitment row");
    assert_eq!(stored.commitment_hash, commitment(0xb1));
    assert_eq!(stored.token, token);
    assert!(stored.created_at > 0);
    expect_success(
        call_with(
            &fixture.employer,
            &fixture.contract,
            "commit_salary",
            json!({
                "employee": employee_a.id().to_string(),
                "commitment_hash": commitment(0xb2),
                "cycle_id": 1,
            }),
            commitment_deposit(1),
            Gas::from_tgas(DEFAULT_GAS_TGAS),
        )
        .await,
    );
    let overwritten: CommitmentEntry = view::<Option<CommitmentEntry>>(
        &fixture.contract,
        "get_commitment",
        json!({
            "employer": fixture.employer.id().to_string(),
            "employee": employee_a.id().to_string(),
            "cycle_id": 1,
        }),
    )
    .await
    .expect("overwritten commitment row");
    assert_eq!(overwritten.commitment_hash, commitment(0xb2));
    assert_eq!(overwritten.created_at, stored.created_at);
    let count: u32 = view(
        &fixture.contract,
        "get_commitment_count",
        json!({
            "employer": fixture.employer.id().to_string(),
            "employee": employee_a.id().to_string(),
        }),
    )
    .await;
    assert_eq!(count, 1);

    expect_success(
        call_with(
            &fixture.employer,
            &fixture.contract,
            "commit_salary",
            json!({
                "employee": employee_a.id().to_string(),
                "commitment_hash": commitment(0xb3),
                "cycle_id": 2,
            }),
            commitment_deposit(1),
            Gas::from_tgas(DEFAULT_GAS_TGAS),
        )
        .await,
    );
    let count: u32 = view(
        &fixture.contract,
        "get_commitment_count",
        json!({
            "employer": fixture.employer.id().to_string(),
            "employee": employee_a.id().to_string(),
        }),
    )
    .await;
    assert_eq!(count, 2);

    expect_failure(
        call_with(
            &fixture.other,
            &fixture.contract,
            "commit_salary",
            json!({
                "employee": employee_a.id().to_string(),
                "commitment_hash": commitment(0xb4),
                "cycle_id": 7,
            }),
            commitment_deposit(1),
            Gas::from_tgas(DEFAULT_GAS_TGAS),
        )
        .await,
        "Employee not registered",
    );

    // Batch commits: exact n * 182 B deposit, cap, and all-or-nothing writes.
    let batch = vec![
        CommitItem {
            employee: employee_a.id().clone(),
            commitment_hash: commitment(0xc1),
            cycle_id: 3,
        },
        CommitItem {
            employee: employee_b.id().clone(),
            commitment_hash: commitment(0xc2),
            cycle_id: 1,
        },
        CommitItem {
            employee: employee_c.id().clone(),
            commitment_hash: commitment(0xc3),
            cycle_id: 1,
        },
    ];
    expect_failure(
        call_with(
            &fixture.employer,
            &fixture.contract,
            "batch_commit_salaries",
            json!({ "items": batch.clone() }),
            one_less(commitment_deposit(batch.len())),
            Gas::from_tgas(DEFAULT_GAS_TGAS),
        )
        .await,
        "Requires attached deposit",
    );
    expect_success(
        call_with(
            &fixture.employer,
            &fixture.contract,
            "batch_commit_salaries",
            json!({ "items": batch }),
            commitment_deposit(3),
            Gas::from_tgas(DEFAULT_GAS_TGAS),
        )
        .await,
    );
    let count: u32 = view(
        &fixture.contract,
        "get_commitment_count",
        json!({
            "employer": fixture.employer.id().to_string(),
            "employee": employee_a.id().to_string(),
        }),
    )
    .await;
    assert_eq!(count, 3);
    let stored: CommitmentEntry = view::<Option<CommitmentEntry>>(
        &fixture.contract,
        "get_commitment",
        json!({
            "employer": fixture.employer.id().to_string(),
            "employee": employee_b.id().to_string(),
            "cycle_id": 1,
        }),
    )
    .await
    .expect("batch commitment row");
    assert_eq!(stored.commitment_hash, commitment(0xc2));

    expect_failure(
        call(
            &fixture.employer,
            &fixture.contract,
            "batch_commit_salaries",
            json!({ "items": [] }),
        )
        .await,
        "Batch must contain at least one item",
    );
    let oversized = (0..=MAX_BATCH_COMMITS)
        .map(|cycle_id| CommitItem {
            employee: employee_a.id().clone(),
            commitment_hash: commitment(0xd0),
            cycle_id: cycle_id as u64,
        })
        .collect::<Vec<_>>();
    expect_failure(
        call(
            &fixture.employer,
            &fixture.contract,
            "batch_commit_salaries",
            json!({ "items": oversized }),
        )
        .await,
        "Batch exceeds the 50 commit cap",
    );
    let atomic = vec![
        CommitItem {
            employee: employee_a.id().clone(),
            commitment_hash: commitment(0xd1),
            cycle_id: 9,
        },
        CommitItem {
            employee: account("ghost.testnet"),
            commitment_hash: commitment(0xd2),
            cycle_id: 9,
        },
    ];
    expect_failure(
        call_with(
            &fixture.employer,
            &fixture.contract,
            "batch_commit_salaries",
            json!({ "items": atomic }),
            commitment_deposit(2),
            Gas::from_tgas(DEFAULT_GAS_TGAS),
        )
        .await,
        "Employee not registered",
    );
    let absent: Option<CommitmentEntry> = view(
        &fixture.contract,
        "get_commitment",
        json!({
            "employer": fixture.employer.id().to_string(),
            "employee": employee_a.id().to_string(),
            "cycle_id": 9,
        }),
    )
    .await;
    assert!(absent.is_none(), "failed batch must write nothing");

    // Deactivation keeps the audit row and is idempotent-checked.
    expect_success(
        call(
            &fixture.employer,
            &fixture.contract,
            "deactivate_employee",
            json!({ "employee": employee_a.id().to_string() }),
        )
        .await,
    );
    let inactive: EmployeeEntry = view::<Option<EmployeeEntry>>(
        &fixture.contract,
        "get_employee",
        json!({
            "employer": fixture.employer.id().to_string(),
            "employee": employee_a.id().to_string(),
        }),
    )
    .await
    .expect("inactive employee row");
    assert!(!inactive.active);
    let exists: bool = view(
        &fixture.contract,
        "employee_exists",
        json!({
            "employer": fixture.employer.id().to_string(),
            "employee": employee_a.id().to_string(),
        }),
    )
    .await;
    assert!(exists);
    expect_failure(
        call(
            &fixture.employer,
            &fixture.contract,
            "deactivate_employee",
            json!({ "employee": employee_a.id().to_string() }),
        )
        .await,
        "Employee already inactive",
    );

    // Global pause: owner-only, blocks every mutator, views unaffected.
    expect_failure(
        call(
            &fixture.other,
            &fixture.contract,
            "set_pause",
            json!({ "paused": true }),
        )
        .await,
        "Owner only",
    );
    expect_success(
        call(
            &fixture.owner,
            &fixture.contract,
            "set_pause",
            json!({ "paused": true }),
        )
        .await,
    );
    expect_failure(
        call_with(
            &fixture.employer,
            &fixture.contract,
            "register_employee",
            json!({
                "employee": employee_d.id().to_string(),
                "salary_commitment": commitment(0xe1),
                "token": token.to_string(),
                "metadata": "paused",
            }),
            employee_deposit("paused"),
            Gas::from_tgas(DEFAULT_GAS_TGAS),
        )
        .await,
        "Disallowed while contract is paused",
    );
    expect_failure(
        call_with(
            &fixture.employer,
            &fixture.contract,
            "commit_salary",
            json!({
                "employee": employee_b.id().to_string(),
                "commitment_hash": commitment(0xe2),
                "cycle_id": 10,
            }),
            commitment_deposit(1),
            Gas::from_tgas(DEFAULT_GAS_TGAS),
        )
        .await,
        "Disallowed while contract is paused",
    );
    expect_failure(
        schedule(
            &fixture,
            &employee_b,
            &commitment(0xe3),
            "paused",
            0,
            payout_deposit("paused"),
        )
        .await,
        "Disallowed while contract is paused",
    );
    expect_failure(
        call_with(
            &fixture.employer,
            &fixture.contract,
            "create_audit_hold",
            json!({
                "hold_id": "paused-hold",
                "employer": fixture.employer.id().to_string(),
                "scope": "Employer",
                "scope_id": "paused",
                "reason_code": "OTHER",
            }),
            hold_deposit("paused-hold", "paused"),
            Gas::from_tgas(DEFAULT_GAS_TGAS),
        )
        .await,
        "Disallowed while contract is paused",
    );
    expect_failure(
        call(
            &fixture.owner,
            &fixture.contract,
            "add_verification_key",
            json!({ "vk_bytes": vec![0u8; 10], "description": "paused" }),
        )
        .await,
        "Disallowed while contract is paused",
    );
    expect_failure(
        call(
            &fixture.owner,
            &fixture.contract,
            "set_active_verification_key",
            json!({ "id": 1 }),
        )
        .await,
        "Disallowed while contract is paused",
    );
    expect_failure(
        call(
            &fixture.owner,
            &fixture.contract,
            "grant_auditor",
            json!({
                "employer": fixture.employer.id().to_string(),
                "auditor": fixture.other.id().to_string(),
            }),
        )
        .await,
        "Disallowed while contract is paused",
    );
    expect_success(
        call(
            &fixture.owner,
            &fixture.contract,
            "set_pause",
            json!({ "paused": false }),
        )
        .await,
    );
    // `set_pause(false)` is idempotent (it sets the slot directly).
    expect_success(
        call(
            &fixture.owner,
            &fixture.contract,
            "set_pause",
            json!({ "paused": false }),
        )
        .await,
    );
    expect_success(
        call_with(
            &fixture.employer,
            &fixture.contract,
            "register_employee",
            json!({
                "employee": employee_d.id().to_string(),
                "salary_commitment": commitment(0xe1),
                "token": token.to_string(),
                "metadata": "resumed",
            }),
            employee_deposit("resumed"),
            Gas::from_tgas(DEFAULT_GAS_TGAS),
        )
        .await,
    );
}

// Payout lifecycle, failures, and fast-forward expiry

#[tokio::test]
async fn sandbox_payout_lifecycle_and_expiry() {
    let _serial = serial().await;
    let fixture = setup().await;
    let token = account("usdc.testnet");
    let employee = fixture
        .worker
        .dev_create_account()
        .await
        .expect("payout employee");

    expect_success(
        call_with(
            &fixture.employer,
            &fixture.contract,
            "register_employee",
            json!({
                "employee": employee.id().to_string(),
                "salary_commitment": commitment(0xf1),
                "token": token.to_string(),
                "metadata": "payout-employee",
            }),
            employee_deposit("payout-employee"),
            Gas::from_tgas(DEFAULT_GAS_TGAS),
        )
        .await,
    );
    expect_success(
        call_with(
            &fixture.employer,
            &fixture.contract,
            "commit_salary",
            json!({
                "employee": employee.id().to_string(),
                "commitment_hash": commitment(0xf2),
                "cycle_id": 1,
            }),
            commitment_deposit(1),
            Gas::from_tgas(DEFAULT_GAS_TGAS),
        )
        .await,
    );

    let block = fixture
        .worker
        .view_block()
        .await
        .expect("current sandbox block");
    let now = block.timestamp();
    let memo = "nov-2026";

    expect_failure(
        schedule(
            &fixture,
            &employee,
            &commitment(0xf3),
            memo,
            now.saturating_add(86_400_000_000_000),
            one_less(payout_deposit(memo)),
        )
        .await,
        "Requires attached deposit",
    );
    let long_memo = "m".repeat(257);
    expect_failure(
        schedule(
            &fixture,
            &employee,
            &commitment(0xf3),
            &long_memo,
            now.saturating_add(86_400_000_000_000),
            payout_deposit(&long_memo),
        )
        .await,
        "memo must be at most 256 bytes",
    );
    expect_failure(
        schedule(
            &fixture,
            &employee,
            "not-a-hash",
            memo,
            now.saturating_add(86_400_000_000_000),
            payout_deposit(memo),
        )
        .await,
        "commitment hash must be exactly 64 lowercase hexadecimal characters",
    );

    let execute_at = now.saturating_add(86_400_000_000_000);
    let payout_id: u64 = success_json(
        schedule(
            &fixture,
            &employee,
            &commitment(0xf3),
            memo,
            execute_at,
            payout_deposit(memo),
        )
        .await,
    );
    assert_eq!(payout_id, 1);
    let stored = payout(&fixture, payout_id).await;
    assert_eq!(stored.employer, *fixture.employer.id());
    assert_eq!(stored.employee, *employee.id());
    assert_eq!(stored.commitment_hash, commitment(0xf3));
    assert_eq!(stored.asset, token);
    assert_eq!(stored.memo, memo);
    assert_eq!(stored.execute_at, execute_at);
    assert!(stored.created_at > 0);
    assert_eq!(stored.state, PayoutState::Pending);
    assert!(stored.intent_hash.is_none());

    let pending: Vec<PayoutEntry> = view(
        &fixture.contract,
        "get_pending_payouts",
        json!({
            "employer": fixture.employer.id().to_string(),
            "from_index": 0,
            "limit": 10,
        }),
    )
    .await;
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].state, PayoutState::Pending);
    expect_view_failure(
        &fixture.contract,
        "get_pending_payouts",
        json!({
            "employer": fixture.employer.id().to_string(),
            "from_index": 0,
            "limit": 0,
        }),
    )
    .await;

    // Wrong callers cannot observe or mutate another employer's payout.
    expect_failure(
        call(
            &fixture.other,
            &fixture.contract,
            "cancel_payout",
            json!({ "payout_id": payout_id, "reason_code": "other" }),
        )
        .await,
        "Payout not found",
    );
    expect_failure(
        call(
            &fixture.other,
            &fixture.contract,
            "mark_settled",
            json!({ "payout_id": payout_id, "intent_hash": "5".repeat(44) }),
        )
        .await,
        "Payout not found",
    );
    expect_failure(
        call(
            &fixture.other,
            &fixture.contract,
            "mark_failed",
            json!({ "payout_id": payout_id, "status": "FAILED" }),
        )
        .await,
        "Payout not found",
    );
    expect_failure(
        call(
            &fixture.other,
            &fixture.contract,
            "expire_payout",
            json!({ "payout_id": payout_id }),
        )
        .await,
        "Payout not found",
    );

    expect_failure(
        call(
            &fixture.employer,
            &fixture.contract,
            "cancel_payout",
            json!({ "payout_id": payout_id, "reason_code": "refund" }),
        )
        .await,
        "Unsupported cancellation reason code",
    );
    expect_failure(
        call(
            &fixture.employer,
            &fixture.contract,
            "mark_failed",
            json!({ "payout_id": payout_id, "status": "SUCCESS" }),
        )
        .await,
        "status must be FAILED or REFUNDED",
    );
    expect_failure(
        call(
            &fixture.employer,
            &fixture.contract,
            "mark_settled",
            json!({ "payout_id": payout_id, "intent_hash": "short" }),
        )
        .await,
        "intent_hash must be 32-88 base58 characters",
    );

    let intent_hash = "5".repeat(44);
    expect_success(
        call(
            &fixture.employer,
            &fixture.contract,
            "mark_settled",
            json!({ "payout_id": payout_id, "intent_hash": intent_hash.clone() }),
        )
        .await,
    );
    let settled = payout(&fixture, payout_id).await;
    assert_eq!(settled.state, PayoutState::Executed);
    assert_eq!(settled.intent_hash.as_deref(), Some(intent_hash.as_str()));
    expect_failure(
        call(
            &fixture.employer,
            &fixture.contract,
            "mark_settled",
            json!({ "payout_id": payout_id, "intent_hash": intent_hash }),
        )
        .await,
        "Payout is not pending",
    );
    expect_failure(
        call(
            &fixture.employer,
            &fixture.contract,
            "cancel_payout",
            json!({ "payout_id": payout_id, "reason_code": "other" }),
        )
        .await,
        "Payout is not pending",
    );
    assert!(!is_due(&fixture, payout_id).await);

    // Cancellation and both terminal 1Click failure statuses.
    let cancelled: u64 = success_json(
        schedule(
            &fixture,
            &employee,
            &commitment(0xf4),
            "cancelled",
            now.saturating_add(86_400_000_000_000),
            payout_deposit("cancelled"),
        )
        .await,
    );
    expect_success(
        call(
            &fixture.employer,
            &fixture.contract,
            "cancel_payout",
            json!({ "payout_id": cancelled, "reason_code": "employee_dispute" }),
        )
        .await,
    );
    assert_eq!(
        payout(&fixture, cancelled).await.state,
        PayoutState::Cancelled
    );
    expect_failure(
        call(
            &fixture.employer,
            &fixture.contract,
            "cancel_payout",
            json!({ "payout_id": cancelled, "reason_code": "employee_dispute" }),
        )
        .await,
        "Payout is not pending",
    );

    let failed: u64 = success_json(
        schedule(
            &fixture,
            &employee,
            &commitment(0xf5),
            "failed",
            now.saturating_add(86_400_000_000_000),
            payout_deposit("failed"),
        )
        .await,
    );
    expect_success(
        call(
            &fixture.employer,
            &fixture.contract,
            "mark_failed",
            json!({ "payout_id": failed, "status": "FAILED" }),
        )
        .await,
    );
    assert_eq!(payout(&fixture, failed).await.state, PayoutState::Failed);

    let refunded: u64 = success_json(
        schedule(
            &fixture,
            &employee,
            &commitment(0xf6),
            "refunded",
            now.saturating_add(86_400_000_000_000),
            payout_deposit("refunded"),
        )
        .await,
    );
    expect_success(
        call(
            &fixture.employer,
            &fixture.contract,
            "mark_failed",
            json!({ "payout_id": refunded, "status": "REFUNDED" }),
        )
        .await,
    );
    assert_eq!(payout(&fixture, refunded).await.state, PayoutState::Failed);

    let pending: Vec<PayoutEntry> = view(
        &fixture.contract,
        "get_pending_payouts",
        json!({
            "employer": fixture.employer.id().to_string(),
            "from_index": 0,
            "limit": 10,
        }),
    )
    .await;
    assert!(pending.is_empty(), "terminal payouts are not pending");
    let count: u32 = view(
        &fixture.contract,
        "get_payout_count",
        json!({ "employer": fixture.employer.id().to_string() }),
    )
    .await;
    assert_eq!(count, 4);

    // `fast_forward` advances block height and the sandbox timestamp by
    // height * average block production delay. Measure the rate first, then
    // cross `execute_at` with a second forward.
    let before = fixture
        .worker
        .view_block()
        .await
        .expect("pre-forward block");
    fixture
        .worker
        .fast_forward(20)
        .await
        .expect("first fast_forward");
    let advanced = fixture
        .worker
        .view_block()
        .await
        .expect("post-forward block");
    let delta_height = advanced.height().saturating_sub(before.height());
    let delta_ns = advanced.timestamp().saturating_sub(before.timestamp());
    assert!(delta_height > 0, "fast_forward advances height");
    assert!(delta_ns > 0, "fast_forward advances the timestamp");
    let per_block = delta_ns / delta_height;
    assert!(per_block > 0, "sandbox block time must be positive");

    let due_at = advanced
        .timestamp()
        .saturating_add(per_block.saturating_mul(25));
    let upcoming: u64 = success_json(
        schedule(
            &fixture,
            &employee,
            &commitment(0xf7),
            "upcoming",
            due_at,
            payout_deposit("upcoming"),
        )
        .await,
    );
    assert!(!is_due(&fixture, upcoming).await);
    expect_failure(
        call(
            &fixture.employer,
            &fixture.contract,
            "expire_payout",
            json!({ "payout_id": upcoming }),
        )
        .await,
        "Payout cannot be expired yet",
    );
    fixture
        .worker
        .fast_forward(20)
        .await
        .expect("second fast_forward");
    let after = fixture
        .worker
        .view_block()
        .await
        .expect("block after second fast_forward");
    assert!(
        after.timestamp() >= due_at,
        "fast_forward must pass execute_at: {} < {due_at}",
        after.timestamp()
    );
    assert!(is_due(&fixture, upcoming).await);
    expect_failure(
        call(
            &fixture.employer,
            &fixture.contract,
            "expire_payout",
            json!({ "payout_id": upcoming }),
        )
        .await,
        "Payout cannot be expired yet",
    );

    // `execute_at = 0` is already older than the 1 h grace window; the sandbox
    // timestamp proves the current-timer path without a 24k-block forward.
    let current = fixture
        .worker
        .view_block()
        .await
        .expect("current block")
        .timestamp();
    assert!(
        current >= GRACE_NS,
        "sandbox clock {current} must exceed GRACE_NS {GRACE_NS}"
    );
    let expired: u64 = success_json(
        schedule(
            &fixture,
            &employee,
            &commitment(0xf8),
            "expired",
            0,
            payout_deposit("expired"),
        )
        .await,
    );
    assert!(is_due(&fixture, expired).await);
    expect_success(
        call(
            &fixture.employer,
            &fixture.contract,
            "expire_payout",
            json!({ "payout_id": expired }),
        )
        .await,
    );
    assert_eq!(payout(&fixture, expired).await.state, PayoutState::Expired);
    assert!(!is_due(&fixture, expired).await);
    expect_failure(
        call(
            &fixture.employer,
            &fixture.contract,
            "expire_payout",
            json!({ "payout_id": expired }),
        )
        .await,
        "Payout is not pending",
    );
    assert!(!is_due(&fixture, 999).await);

    let count: u32 = view(
        &fixture.contract,
        "get_payout_count",
        json!({ "employer": fixture.employer.id().to_string() }),
    )
    .await;
    assert_eq!(count, 6);
    let pending: Vec<PayoutEntry> = view(
        &fixture.contract,
        "get_pending_payouts",
        json!({
            "employer": fixture.employer.id().to_string(),
            "from_index": 0,
            "limit": 10,
        }),
    )
    .await;
    assert_eq!(
        pending.len(),
        1,
        "the due-but-not-expired payout remains pending"
    );
    assert_eq!(pending[0].employee, *employee.id());
}

// Holds and auditor roles

#[tokio::test]
async fn sandbox_holds_and_auditor_roles() {
    let _serial = serial().await;
    let fixture = setup().await;
    let auditor = fixture
        .worker
        .dev_create_account()
        .await
        .expect("auditor account");
    let employee = fixture
        .worker
        .dev_create_account()
        .await
        .expect("hold scope employee");

    expect_failure(
        call(
            &fixture.other,
            &fixture.contract,
            "grant_auditor",
            json!({
                "employer": fixture.employer.id().to_string(),
                "auditor": auditor.id().to_string(),
            }),
        )
        .await,
        "Owner only",
    );
    expect_success(
        call(
            &fixture.employer,
            &fixture.contract,
            "grant_auditor",
            json!({
                "employer": fixture.employer.id().to_string(),
                "auditor": auditor.id().to_string(),
            }),
        )
        .await,
    );

    let hold_id = "hold-kyc";
    let scope_id = employee.id().to_string();
    let deposit = hold_deposit(hold_id, &scope_id);
    expect_failure(
        call_with(
            &fixture.employer,
            &fixture.contract,
            "create_audit_hold",
            json!({
                "hold_id": hold_id,
                "employer": fixture.employer.id().to_string(),
                "scope": "Employee",
                "scope_id": scope_id,
                "reason_code": "KYC_REVIEW_PENDING",
            }),
            one_less(deposit),
            Gas::from_tgas(DEFAULT_GAS_TGAS),
        )
        .await,
        "Requires attached deposit",
    );
    expect_failure(
        call_with(
            &fixture.employer,
            &fixture.contract,
            "create_audit_hold",
            json!({
                "hold_id": hold_id,
                "employer": fixture.employer.id().to_string(),
                "scope": "Employee",
                "scope_id": scope_id,
                "reason_code": "kyc_review_pending",
            }),
            deposit,
            Gas::from_tgas(DEFAULT_GAS_TGAS),
        )
        .await,
        "Unknown hold reason code",
    );
    expect_failure(
        call_with(
            &fixture.employer,
            &fixture.contract,
            "create_audit_hold",
            json!({
                "hold_id": "",
                "employer": fixture.employer.id().to_string(),
                "scope": "Employee",
                "scope_id": scope_id,
                "reason_code": "KYC_REVIEW_PENDING",
            }),
            hold_deposit("", &scope_id),
            Gas::from_tgas(DEFAULT_GAS_TGAS),
        )
        .await,
        "hold_id must be 1..=128 bytes",
    );
    expect_failure(
        call_with(
            &fixture.other,
            &fixture.contract,
            "create_audit_hold",
            json!({
                "hold_id": "hold-outsider",
                "employer": fixture.employer.id().to_string(),
                "scope": "Employer",
                "scope_id": "outsider",
                "reason_code": "OTHER",
            }),
            hold_deposit("hold-outsider", "outsider"),
            Gas::from_tgas(DEFAULT_GAS_TGAS),
        )
        .await,
        "Only the employer or an auditor can create a hold",
    );

    expect_success(
        call_with(
            &fixture.employer,
            &fixture.contract,
            "create_audit_hold",
            json!({
                "hold_id": hold_id,
                "employer": fixture.employer.id().to_string(),
                "scope": "Employee",
                "scope_id": scope_id,
                "reason_code": "KYC_REVIEW_PENDING",
            }),
            deposit,
            Gas::from_tgas(DEFAULT_GAS_TGAS),
        )
        .await,
    );
    let held: HoldEntry = view::<Option<HoldEntry>>(
        &fixture.contract,
        "get_audit_hold",
        json!({ "hold_id": hold_id }),
    )
    .await
    .expect("hold row");
    assert_eq!(held.employer, *fixture.employer.id());
    assert_eq!(held.scope, HoldScope::Employee);
    assert_eq!(held.scope_id, scope_id);
    assert_eq!(held.reason_code, HoldReason::KycReviewPending);
    assert_eq!(held.state, HoldState::Active);
    assert_eq!(held.placed_by, *fixture.employer.id());
    assert!(held.placed_at > 0);
    assert!(held.released_by.is_none());
    assert!(held.released_at.is_none());
    assert!(held.release_reason.is_none());
    expect_failure(
        call_with(
            &fixture.employer,
            &fixture.contract,
            "create_audit_hold",
            json!({
                "hold_id": hold_id,
                "employer": fixture.employer.id().to_string(),
                "scope": "Employee",
                "scope_id": scope_id,
                "reason_code": "KYC_REVIEW_PENDING",
            }),
            deposit,
            Gas::from_tgas(DEFAULT_GAS_TGAS),
        )
        .await,
        "Hold already exists",
    );

    // The granted auditor may place a hold on the employer's behalf.
    let audited_hold = "hold-audit";
    let audited_scope = "2026-11";
    expect_success(
        call_with(
            &auditor,
            &fixture.contract,
            "create_audit_hold",
            json!({
                "hold_id": audited_hold,
                "employer": fixture.employer.id().to_string(),
                "scope": "Period",
                "scope_id": audited_scope,
                "reason_code": "SANCTIONS_SCREENING",
            }),
            hold_deposit(audited_hold, audited_scope),
            Gas::from_tgas(DEFAULT_GAS_TGAS),
        )
        .await,
    );
    let held: HoldEntry = view::<Option<HoldEntry>>(
        &fixture.contract,
        "get_audit_hold",
        json!({ "hold_id": audited_hold }),
    )
    .await
    .expect("auditor hold row");
    assert_eq!(held.scope, HoldScope::Period);
    assert_eq!(held.reason_code, HoldReason::SanctionsScreening);
    assert_eq!(held.placed_by, *auditor.id());

    expect_failure(
        call(
            &fixture.other,
            &fixture.contract,
            "release_audit_hold",
            json!({ "hold_id": audited_hold, "release_reason": "REGULATORY_INVESTIGATION" }),
        )
        .await,
        "Only the employer or an auditor can release a hold",
    );
    expect_success(
        call(
            &fixture.employer,
            &fixture.contract,
            "release_audit_hold",
            json!({ "hold_id": audited_hold, "release_reason": "REGULATORY_INVESTIGATION" }),
        )
        .await,
    );
    let released: HoldEntry = view::<Option<HoldEntry>>(
        &fixture.contract,
        "get_audit_hold",
        json!({ "hold_id": audited_hold }),
    )
    .await
    .expect("released hold row");
    assert_eq!(released.state, HoldState::Released);
    assert_eq!(released.released_by, Some(fixture.employer.id().clone()));
    assert!(released.released_at.expect("release timestamp") > 0);
    assert_eq!(
        released.release_reason,
        Some(HoldReason::RegulatoryInvestigation)
    );
    expect_failure(
        call(
            &fixture.employer,
            &fixture.contract,
            "release_audit_hold",
            json!({ "hold_id": audited_hold, "release_reason": "REGULATORY_INVESTIGATION" }),
        )
        .await,
        "Hold is not active",
    );
    expect_failure(
        call(
            &fixture.employer,
            &fixture.contract,
            "release_audit_hold",
            json!({ "hold_id": "missing-hold", "release_reason": "OTHER" }),
        )
        .await,
        "Hold not found",
    );

    expect_success(
        call(
            &fixture.employer,
            &fixture.contract,
            "release_audit_hold",
            json!({ "hold_id": hold_id, "release_reason": "MANUAL_REVIEW_REQUESTED" }),
        )
        .await,
    );
    let ids: Vec<String> = view(
        &fixture.contract,
        "get_hold_ids",
        json!({
            "employer": fixture.employer.id().to_string(),
            "from_index": 0,
            "limit": 10,
        }),
    )
    .await;
    assert_eq!(ids, vec![hold_id.to_string(), audited_hold.to_string()]);
    let first: Vec<String> = view(
        &fixture.contract,
        "get_hold_ids",
        json!({
            "employer": fixture.employer.id().to_string(),
            "from_index": 0,
            "limit": 1,
        }),
    )
    .await;
    assert_eq!(first, vec![hold_id.to_string()]);
    expect_view_failure(
        &fixture.contract,
        "get_hold_ids",
        json!({
            "employer": fixture.employer.id().to_string(),
            "from_index": 0,
            "limit": 0,
        }),
    )
    .await;

    // Revocation removes hold rights; owner grant works for any employer.
    expect_failure(
        call(
            &fixture.other,
            &fixture.contract,
            "revoke_auditor",
            json!({
                "employer": fixture.employer.id().to_string(),
                "auditor": auditor.id().to_string(),
            }),
        )
        .await,
        "Owner only",
    );
    expect_success(
        call(
            &fixture.employer,
            &fixture.contract,
            "revoke_auditor",
            json!({
                "employer": fixture.employer.id().to_string(),
                "auditor": auditor.id().to_string(),
            }),
        )
        .await,
    );
    expect_failure(
        call_with(
            &auditor,
            &fixture.contract,
            "create_audit_hold",
            json!({
                "hold_id": "hold-revoked",
                "employer": fixture.employer.id().to_string(),
                "scope": "Batch",
                "scope_id": "batch-1",
                "reason_code": "OTHER",
            }),
            hold_deposit("hold-revoked", "batch-1"),
            Gas::from_tgas(DEFAULT_GAS_TGAS),
        )
        .await,
        "Only the employer or an auditor can create a hold",
    );
    expect_success(
        call(
            &fixture.owner,
            &fixture.contract,
            "grant_auditor",
            json!({
                "employer": fixture.employer.id().to_string(),
                "auditor": auditor.id().to_string(),
            }),
        )
        .await,
    );
    expect_success(
        call_with(
            &auditor,
            &fixture.contract,
            "create_audit_hold",
            json!({
                "hold_id": "hold-restored",
                "employer": fixture.employer.id().to_string(),
                "scope": "Batch",
                "scope_id": "batch-1",
                "reason_code": "TAX_WITHHOLDING_DISCREPANCY",
            }),
            hold_deposit("hold-restored", "batch-1"),
            Gas::from_tgas(DEFAULT_GAS_TGAS),
        )
        .await,
    );
    let restored: HoldEntry = view::<Option<HoldEntry>>(
        &fixture.contract,
        "get_audit_hold",
        json!({ "hold_id": "hold-restored" }),
    )
    .await
    .expect("restored auditor hold");
    assert_eq!(restored.placed_by, *auditor.id());
    assert_eq!(restored.reason_code, HoldReason::TaxWithholdingDiscrepancy);
    let missing: Option<HoldEntry> = view(
        &fixture.contract,
        "get_audit_hold",
        json!({ "hold_id": "does-not-exist" }),
    )
    .await;
    assert!(missing.is_none());
}

// Groth16 fixture: verify, negative encodings, replay, insufficient gas

fn fixture_json(text: &str) -> Value {
    near_sdk::serde_json::from_str(text).expect("fixture is valid JSON")
}

fn decimal_le_32(text: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    assert!(!text.is_empty(), "decimal string must not be empty");
    for byte in text.bytes() {
        assert!(byte.is_ascii_digit(), "decimal digits only: {text}");
        let mut carry = u32::from(byte - b'0');
        for limb in out.iter_mut() {
            let value = u32::from(*limb) * 10 + carry;
            *limb = (value & 0xff) as u8;
            carry = value >> 8;
        }
        assert_eq!(carry, 0, "decimal does not fit in 256 bits: {text}");
    }
    out
}

fn json_decimal(value: &Value) -> [u8; 32] {
    decimal_le_32(value.as_str().expect("decimal string"))
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
    out.extend_from_slice(&json_decimal(&x[0]));
    out.extend_from_slice(&json_decimal(&x[1]));
    out.extend_from_slice(&json_decimal(&y[0]));
    out.extend_from_slice(&json_decimal(&y[1]));
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

fn evm_order_proof() -> Vec<u8> {
    // EIP-197 swaps the Fq2 real/imaginary halves of each G2 point.
    let mut bytes = fixture_proof_bytes();
    for start in [64usize, 128usize] {
        for index in 0..32 {
            bytes.swap(start + index, start + 32 + index);
        }
    }
    bytes
}

fn assert_not_verified(outcome: ExecutionFinalResult) {
    if let Ok(success) = outcome.into_result() {
        let verified: bool = success.json().expect("verify_proof returns a JSON boolean");
        assert!(!verified, "invalid proof encoding must not verify");
    }
}

fn assert_insufficient_gas(outcome: ExecutionFinalResult) {
    match outcome.into_result() {
        Ok(success) => {
            let verified: bool = success.json().expect("verify_proof returns a JSON boolean");
            assert!(!verified, "5 Tgas must not verify the fixture proof");
        }
        Err(failure) => {
            let text = format!("{failure:?}");
            assert!(
                text.to_ascii_lowercase().contains("gas"),
                "expected gas exhaustion, got: {text}"
            );
        }
    }
}

async fn verify(
    fixture: &Fixture,
    caller: &Account,
    proof: Vec<u8>,
    public_inputs: Vec<String>,
    verification_key_id: u32,
    deposit: NearToken,
    tgas: u64,
) -> ExecutionFinalResult {
    call_with(
        caller,
        &fixture.contract,
        "verify_proof",
        json!({
            "proof_bytes": proof,
            "public_inputs": public_inputs,
            "verification_key_id": verification_key_id,
        }),
        deposit,
        Gas::from_tgas(tgas),
    )
    .await
}

#[tokio::test]
async fn sandbox_groth16_fixture() {
    let _serial = serial().await;
    let fixture = setup().await;
    let vk = fixture_vk_bytes();
    let proof = fixture_proof_bytes();
    let public_inputs = fixture_public_inputs();
    assert_eq!(public_inputs, vec!["33".to_string()]);

    expect_failure(
        call(
            &fixture.other,
            &fixture.contract,
            "add_verification_key",
            json!({ "vk_bytes": vk.clone(), "description": "multiplier2" }),
        )
        .await,
        "Owner only",
    );
    expect_failure(
        call(
            &fixture.owner,
            &fixture.contract,
            "add_verification_key",
            json!({ "vk_bytes": vec![0u8; 10], "description": "broken" }),
        )
        .await,
        "Invalid verification key encoding",
    );
    let key_id: u32 = success_json(
        call(
            &fixture.owner,
            &fixture.contract,
            "add_verification_key",
            json!({ "vk_bytes": vk.clone(), "description": "multiplier2" }),
        )
        .await,
    );
    assert_eq!(key_id, 1);
    let count: u32 = view(&fixture.contract, "get_verification_key_count", json!({})).await;
    assert_eq!(count, 1);
    let active: u32 = view(
        &fixture.contract,
        "get_active_verification_key_id",
        json!({}),
    )
    .await;
    assert_eq!(active, 0);

    let raw: Option<Vec<u8>> = view(
        &fixture.contract,
        "get_verification_key",
        json!({ "id": key_id }),
    )
    .await;
    assert_eq!(raw, Some(vk.clone()));
    let info: Option<VerificationKeyInfo> = view(
        &fixture.contract,
        "get_verification_key_info",
        json!({ "id": key_id }),
    )
    .await;
    let info = info.expect("verification key info");
    assert_eq!(info.description, "multiplier2");
    assert_eq!(info.key, vk);
    let missing: Option<Vec<u8>> = view(
        &fixture.contract,
        "get_verification_key",
        json!({ "id": 2 }),
    )
    .await;
    assert!(missing.is_none());
    let missing_info: Option<VerificationKeyInfo> = view(
        &fixture.contract,
        "get_verification_key_info",
        json!({ "id": 2 }),
    )
    .await;
    assert!(missing_info.is_none());

    expect_failure(
        call(
            &fixture.other,
            &fixture.contract,
            "set_active_verification_key",
            json!({ "id": key_id }),
        )
        .await,
        "Owner only",
    );
    expect_failure(
        call(
            &fixture.owner,
            &fixture.contract,
            "set_active_verification_key",
            json!({ "id": 99 }),
        )
        .await,
        "Unknown verification key id",
    );
    expect_success(
        call(
            &fixture.owner,
            &fixture.contract,
            "set_active_verification_key",
            json!({ "id": key_id }),
        )
        .await,
    );
    let active: u32 = view(
        &fixture.contract,
        "get_active_verification_key_id",
        json!({}),
    )
    .await;
    assert_eq!(active, key_id);

    // Unknown keys and malformed wire encodings return false.
    let unknown = verify(
        &fixture,
        &fixture.employer,
        proof.clone(),
        public_inputs.clone(),
        99,
        nullifier_deposit(),
        VERIFY_GAS_TGAS,
    )
    .await;
    assert!(!success_json::<bool>(unknown));
    let malformed = verify(
        &fixture,
        &fixture.employer,
        vec![0u8; 255],
        public_inputs.clone(),
        key_id,
        nullifier_deposit(),
        VERIFY_GAS_TGAS,
    )
    .await;
    assert!(!success_json::<bool>(malformed));
    let wrong_input = verify(
        &fixture,
        &fixture.employer,
        proof.clone(),
        vec!["34".to_string()],
        key_id,
        nullifier_deposit(),
        VERIFY_GAS_TGAS,
    )
    .await;
    assert!(!success_json::<bool>(wrong_input));

    // The nullifier deposit is asserted after verification; a short deposit
    // must revert without spending the proof.
    expect_failure(
        verify(
            &fixture,
            &fixture.employer,
            proof.clone(),
            public_inputs.clone(),
            key_id,
            one_less(nullifier_deposit()),
            VERIFY_GAS_TGAS,
        )
        .await,
        "Requires attached deposit",
    );

    // Insufficient gas must abort before consuming the proof nullifier.
    let starved = verify(
        &fixture,
        &fixture.employer,
        proof.clone(),
        public_inputs.clone(),
        key_id,
        nullifier_deposit(),
        5,
    )
    .await;
    assert_insufficient_gas(starved);

    // One-bit flip and EVM-order encodings are rejected without spending the
    // real proof's nullifier.
    let mut flipped = proof.clone();
    flipped[0] ^= 1;
    assert_not_verified(
        verify(
            &fixture,
            &fixture.employer,
            flipped,
            public_inputs.clone(),
            key_id,
            nullifier_deposit(),
            VERIFY_GAS_TGAS,
        )
        .await,
    );
    assert_not_verified(
        verify(
            &fixture,
            &fixture.employer,
            evm_order_proof(),
            public_inputs.clone(),
            key_id,
            nullifier_deposit(),
            VERIFY_GAS_TGAS,
        )
        .await,
    );

    // The known-good fixture verifies and emits proof_verified.
    let accepted = verify(
        &fixture,
        &fixture.employer,
        proof.clone(),
        public_inputs.clone(),
        key_id,
        nullifier_deposit(),
        VERIFY_GAS_TGAS,
    )
    .await;
    let logs = accepted
        .logs()
        .iter()
        .map(|line| (*line).to_string())
        .collect::<Vec<_>>();
    assert!(success_json::<bool>(accepted), "fixture proof must verify");
    assert!(
        logs.iter()
            .any(|line| line.contains("EVENT_JSON:") && line.contains("proof_verified")),
        "successful verification emits proof_verified: {logs:?}"
    );

    // Replay is rejected globally, for any caller.
    expect_failure(
        verify(
            &fixture,
            &fixture.employer,
            proof.clone(),
            public_inputs.clone(),
            key_id,
            nullifier_deposit(),
            VERIFY_GAS_TGAS,
        )
        .await,
        "ProofAlreadyUsed",
    );
    expect_failure(
        verify(
            &fixture,
            &fixture.other,
            proof,
            public_inputs,
            key_id,
            nullifier_deposit(),
            VERIFY_GAS_TGAS,
        )
        .await,
        "ProofAlreadyUsed",
    );
}
