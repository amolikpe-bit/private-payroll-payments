//! subrosa payroll contract: employer/employee registry, salary commitments,
//! scheduled payouts, audit holds, and an optional Groth16 attestation module.
//!
//! Chain state is public: salaries never appear on chain, only commitment
//! hashes. Settlement runs off chain over Confidential Intents and is reported
//! back through the payout lifecycle methods. Every timestamp is
//! `env::block_timestamp()` (nanoseconds since the epoch).
//!
//! # Storage deposits
//!
//! Every method that creates a storage record is `#[payable]` and requires an
//! attached deposit of at least `record_bytes * env::storage_byte_cost()`.
//! The documented record sizes are [`EMPLOYEE_RECORD_BYTES`] (567 B),
//! [`COMMITMENT_RECORD_BYTES`] (374 B), [`PAYOUT_RECORD_BYTES`] (258 B),
//! [`HOLD_RECORD_BYTES`] (186 B) and [`NULLIFIER_RECORD_BYTES`] (73 B); a batch
//! commit requires `items.len() * COMMITMENT_RECORD_BYTES`. The deposit is
//! **retained by the contract**: there is no refund path, and any surplus is
//! not returned.
//!
//! # Authorization
//!
//! Ordinary writes take `employer = env::predecessor_account_id()`. The owner
//! (managed by `near-sdk-contract-tools` `Owner`) controls `set_pause`,
//! `add_verification_key` and `set_active_verification_key`. A single global
//! pause blocks every mutating method except `set_pause` itself.

use near_sdk::borsh::BorshSerialize;
use near_sdk::store::{IterableMap, LookupMap, LookupSet};
use near_sdk::{AccountId, BorshStorageKey, NearToken, PanicOnDefault, env, near, require};
use near_sdk_contract_tools::owner::Owner;
use near_sdk_contract_tools::pause::Pause;

use crate::events::{
    AuditHoldChangedData, AuditorChangedData, EmployeeRegisteredData, EmployeeUpdatedData, Event,
    PayoutScheduledData, PayoutStateChangedData, SalaryCommittedData,
};

pub mod events;
mod groth16;

#[cfg(test)]
#[cfg(not(target_arch = "wasm32"))]
mod tests;

/// Runtime size of one registry row, in bytes (see `CONSTANTS.md`).
pub const EMPLOYEE_RECORD_BYTES: u64 = 567;
/// Runtime size of one salary commitment row, in bytes.
pub const COMMITMENT_RECORD_BYTES: u64 = 374;
/// Runtime size of one scheduled payout row, in bytes.
pub const PAYOUT_RECORD_BYTES: u64 = 258;
/// Runtime size of one audit hold row, in bytes.
pub const HOLD_RECORD_BYTES: u64 = 186;
/// Runtime size of one proof nullifier row, in bytes.
pub const NULLIFIER_RECORD_BYTES: u64 = 73;
/// Maximum number of `CommitItem`s accepted by `batch_commit_salaries`.
pub const MAX_BATCH_COMMITS: usize = 50;
/// Maximum `limit` accepted by the paginated views.
pub const MAX_PAGE_LIMIT: u32 = 500;
/// Maximum number of registry and payout index entries per employer.
pub const MAX_INDEX_ENTRIES: u32 = 500;
/// Grace period after `execute_at` before a pending payout can expire (1 h).
pub const GRACE_NS: u64 = 3_600_000_000_000;
/// Maximum accepted `metadata` length on `register_employee`, in bytes.
pub const MAX_METADATA_BYTES: usize = 256;
/// Maximum accepted `memo` length on `schedule_payout`, in bytes.
pub const MAX_MEMO_BYTES: usize = 256;
/// Maximum accepted verification-key description length, in bytes.
pub const MAX_VK_DESCRIPTION_BYTES: usize = 256;
/// Maximum accepted `hold_id` / `scope_id` length, in bytes.
pub const MAX_HOLD_ID_BYTES: usize = 128;

/// Contract state.
///
/// Ownership and pause state live in the reserved storage slots managed by
/// `near-sdk-contract-tools`; they are not duplicated as struct fields. Every
/// other collection is keyed by employer so per-employer views never need a
/// prefix scan; the matching `*_count` / `*_ids` collections carry the small
/// per-employer indexes.
#[derive(near_sdk_contract_tools::Owner, near_sdk_contract_tools::Pause, PanicOnDefault)]
#[near(contract_state)]
pub struct Contract {
    /// (employer, employee) registry.
    employees: IterableMap<(AccountId, AccountId), EmployeeEntry>,
    /// Per-employer registry size.
    employee_count: LookupMap<AccountId, u32>,
    /// Per-employer registry index (capped at [`MAX_INDEX_ENTRIES`]).
    employee_ids: LookupMap<AccountId, Vec<AccountId>>,
    /// Salary commitments keyed by (employer, employee, cycle id).
    commitments: LookupMap<(AccountId, AccountId, u64), CommitmentEntry>,
    /// Per (employer, employee) commitment count across cycles.
    commitment_count: LookupMap<(AccountId, AccountId), u32>,
    /// Payout rows keyed by (employer, payout id).
    payouts: LookupMap<(AccountId, u64), PayoutEntry>,
    /// Per-employer payout id sequence (ids are 1-based).
    payout_seq: LookupMap<AccountId, u64>,
    /// Per-employer payout id index (capped at [`MAX_INDEX_ENTRIES`]).
    payout_ids: LookupMap<AccountId, Vec<u64>>,
    /// Hold id -> hold row.
    holds: LookupMap<String, HoldEntry>,
    /// Per-employer hold id index.
    hold_ids: LookupMap<AccountId, Vec<String>>,
    /// employer -> auditors allowed to place and release holds.
    auditors: LookupMap<AccountId, LookupSet<AccountId>>,
    /// Verification key id -> key info.
    vks: LookupMap<u32, VerificationKeyInfo>,
    /// Number of registered verification keys; ids are assigned as count + 1.
    vk_count: u32,
    /// Currently active verification key id, or 0 when none is active.
    active_vk: u32,
    /// Spent proof nullifiers ([`env::sha256`] of the proof bytes).
    used_proofs: LookupSet<[u8; 32]>,
}

/// Registry row. `salary_commitment` is the 64-hex commitment digest; the
/// amount and its salt stay with the employer off chain.
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct EmployeeEntry {
    pub salary_commitment: String,
    pub token: AccountId,
    pub metadata: String,
    pub active: bool,
    pub created_at: u64,
    pub updated_at: u64,
}

/// Commitment row for one (employer, employee, cycle) triple. No amount is
/// stored: revelation is export-only and verification is client-side.
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct CommitmentEntry {
    pub commitment_hash: String,
    pub token: AccountId,
    pub created_at: u64,
}

/// Scheduled payout row. Settlement itself happens off chain.
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct PayoutEntry {
    pub employer: AccountId,
    pub employee: AccountId,
    pub commitment_hash: String,
    pub asset: AccountId,
    pub memo: String,
    pub execute_at: u64,
    pub created_at: u64,
    pub state: PayoutState,
    pub intent_hash: Option<String>,
}

/// Payout lifecycle state.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum PayoutState {
    Pending,
    Executed,
    Cancelled,
    Expired,
    Failed,
}

/// Audit hold row. `released_by` / `released_at` / `release_reason` are set only
/// when the hold moves to [`HoldState::Released`].
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct HoldEntry {
    pub employer: AccountId,
    pub scope: HoldScope,
    pub scope_id: String,
    pub reason_code: HoldReason,
    pub state: HoldState,
    pub placed_by: AccountId,
    pub placed_at: u64,
    pub released_by: Option<AccountId>,
    pub released_at: Option<u64>,
    pub release_reason: Option<HoldReason>,
}

/// What a hold applies to; `HoldEntry::scope_id` carries the id within it.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum HoldScope {
    Employer,
    Period,
    Batch,
    Employee,
}

/// Hold lifecycle state.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum HoldState {
    Active,
    Released,
}

/// Closed set of safe, non-identifying hold reasons. Variant names map one to
/// one onto the SDK's uppercase reason codes: `KYC_REVIEW_PENDING`,
/// `SANCTIONS_SCREENING`, `TAX_WITHHOLDING_DISCREPANCY`,
/// `REGULATORY_INVESTIGATION`, `DUPLICATE_PAYMENT_SUSPECTED`,
/// `MANUAL_REVIEW_REQUESTED`, `OTHER`.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum HoldReason {
    KycReviewPending,
    SanctionsScreening,
    TaxWithholdingDiscrepancy,
    RegulatoryInvestigation,
    DuplicatePaymentSuspected,
    ManualReviewRequested,
    Other,
}

/// Groth16 verification key plus a human-readable label.
///
/// `key` holds the raw verification-key bytes; JSON serializes it as a byte
/// array and `get_verification_key` returns the same bytes.
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct VerificationKeyInfo {
    pub key: Vec<u8>,
    pub description: String,
}

/// One commitment item for a batch commit.
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct CommitItem {
    pub employee: AccountId,
    pub commitment_hash: String,
    pub cycle_id: u64,
}

/// Collection prefixes. Each variant serializes to a distinct byte string, so
/// separate collections never share a key space. `AuditorSet` nests a
/// per-employer set under the auditors map and must stay distinct per employer.
#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
pub enum StorageKey {
    /// (employer, employee) registry.
    Employees,
    /// Per-employer registry counter.
    EmployeeCount,
    /// Per-employer registry index.
    EmployeeIds,
    /// (employer, employee, cycle) commitments.
    Commitments,
    /// Per (employer, employee) commitment counter.
    CommitmentCount,
    /// (employer, payout id) payouts.
    Payouts,
    /// Per-employer payout id sequence.
    PayoutSeq,
    /// Per-employer payout id index.
    PayoutIds,
    /// Hold id -> hold row.
    Holds,
    /// Per-employer hold id index.
    HoldIds,
    /// employer -> auditor set.
    Auditors,
    /// Per-employer auditor set nested under the auditors map.
    AuditorSet(AccountId),
    /// Verification key id -> key info.
    VerificationKeys,
    /// Spent proof nullifiers.
    UsedProofs,
}

/// Returns `true` for exactly 64 lowercase hexadecimal characters.
pub(crate) fn is_lowercase_hex_64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// Parses one of the seven uppercase hold reason codes, rejecting everything
/// else (including lowercase or unknown codes).
pub(crate) fn parse_hold_reason(code: &str) -> Option<HoldReason> {
    match code {
        "KYC_REVIEW_PENDING" => Some(HoldReason::KycReviewPending),
        "SANCTIONS_SCREENING" => Some(HoldReason::SanctionsScreening),
        "TAX_WITHHOLDING_DISCREPANCY" => Some(HoldReason::TaxWithholdingDiscrepancy),
        "REGULATORY_INVESTIGATION" => Some(HoldReason::RegulatoryInvestigation),
        "DUPLICATE_PAYMENT_SUSPECTED" => Some(HoldReason::DuplicatePaymentSuspected),
        "MANUAL_REVIEW_REQUESTED" => Some(HoldReason::ManualReviewRequested),
        "OTHER" => Some(HoldReason::Other),
        _ => None,
    }
}

/// Lowercase hex encoding used for proof nullifiers.
pub(crate) fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

/// Origin SDK cancellation reason codes (lowercase snake case).
fn is_cancellation_reason(code: &str) -> bool {
    matches!(
        code,
        "insufficient_funds"
            | "duplicate_run"
            | "employee_dispute"
            | "compliance_hold"
            | "schedule_error"
            | "other"
    )
}

/// A base58 (or 64-hex) intent hash: 32-88 ASCII alphanumeric characters.
fn is_valid_intent_hash(value: &str) -> bool {
    (32..=88).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

impl Contract {
    /// Storage deposit required for `bytes` of new state at the current byte
    /// cost. The value is retained; payments are never refunded.
    pub(crate) fn required_storage_deposit(bytes: u64) -> NearToken {
        NearToken::from_yoctonear(
            env::storage_byte_cost()
                .as_yoctonear()
                .saturating_mul(u128::from(bytes)),
        )
    }

    /// Panics unless the attached deposit covers `bytes` of new state.
    pub(crate) fn assert_storage_deposit(bytes: u64) {
        let required = Self::required_storage_deposit(bytes);
        require!(
            env::attached_deposit() >= required,
            format!(
                "Requires attached deposit of at least {} yoctoNEAR for {} bytes of storage",
                required.as_yoctonear(),
                bytes
            )
        );
    }

    /// Returns whether `account` is an auditor for `employer`.
    fn is_auditor(&self, employer: &AccountId, account: &AccountId) -> bool {
        self.auditors
            .get(employer)
            .map(|auditors| auditors.contains(account))
            .unwrap_or(false)
    }

    /// Panics unless `salary_commitment` is a 64-lowercase-hex digest.
    pub(crate) fn assert_commitment_hash(value: &str) {
        require!(
            is_lowercase_hex_64(value),
            "commitment hash must be exactly 64 lowercase hexadecimal characters"
        );
    }
}

#[near]
impl Contract {
    /// Deployer sets the owner. Storage starts unpaused with no active
    /// verification key. Record-creating methods attached deposits are
    /// retained (no refund path).
    #[init]
    pub fn new(owner: AccountId) -> Self {
        let mut contract = Self {
            employees: IterableMap::new(StorageKey::Employees),
            employee_count: LookupMap::new(StorageKey::EmployeeCount),
            employee_ids: LookupMap::new(StorageKey::EmployeeIds),
            commitments: LookupMap::new(StorageKey::Commitments),
            commitment_count: LookupMap::new(StorageKey::CommitmentCount),
            payouts: LookupMap::new(StorageKey::Payouts),
            payout_seq: LookupMap::new(StorageKey::PayoutSeq),
            payout_ids: LookupMap::new(StorageKey::PayoutIds),
            holds: LookupMap::new(StorageKey::Holds),
            hold_ids: LookupMap::new(StorageKey::HoldIds),
            auditors: LookupMap::new(StorageKey::Auditors),
            vks: LookupMap::new(StorageKey::VerificationKeys),
            vk_count: 0,
            active_vk: 0,
            used_proofs: LookupSet::new(StorageKey::UsedProofs),
        };
        Owner::init(&mut contract, &owner);
        contract
    }

    // Registry

    /// Registers an employee for the predecessor employer.
    ///
    /// `salary_commitment` is the 64-lowercase-hex registration digest
    /// (`REG_DOMAIN`, cycle 0). `metadata` is public state and must not carry
    /// amounts. Requires a deposit covering [`EMPLOYEE_RECORD_BYTES`].
    #[payable]
    pub fn register_employee(
        &mut self,
        employee: AccountId,
        salary_commitment: String,
        token: AccountId,
        metadata: String,
    ) {
        Self::require_unpaused();
        Self::assert_commitment_hash(&salary_commitment);
        require!(
            metadata.len() <= MAX_METADATA_BYTES,
            "metadata must be at most 256 bytes"
        );
        Self::assert_storage_deposit(EMPLOYEE_RECORD_BYTES + metadata.len() as u64);

        let employer = env::predecessor_account_id();
        let key = (employer.clone(), employee.clone());
        require!(
            !self.employees.contains_key(&key),
            "Employee already registered"
        );
        let count = self.employee_count.get(&employer).copied().unwrap_or(0);
        require!(
            count < MAX_INDEX_ENTRIES,
            "Employee index is capped at 500 per employer"
        );

        let now = env::block_timestamp();
        self.employees.insert(
            key,
            EmployeeEntry {
                salary_commitment: salary_commitment.clone(),
                token: token.clone(),
                metadata,
                active: true,
                created_at: now,
                updated_at: now,
            },
        );
        self.employee_count.insert(employer.clone(), count + 1);
        let mut ids = self
            .employee_ids
            .get(&employer)
            .cloned()
            .unwrap_or_default();
        ids.push(employee.clone());
        self.employee_ids.insert(employer.clone(), ids);

        Event::EmployeeRegistered(vec![EmployeeRegisteredData {
            employer,
            employee,
            token,
            commitment_hash: salary_commitment,
            at_ns: now,
        }])
        .emit();
    }

    /// Replaces the employee's commitment hash; the amount stays off chain.
    pub fn update_employee(&mut self, employee: AccountId, salary_commitment: String) {
        Self::require_unpaused();
        Self::assert_commitment_hash(&salary_commitment);

        let employer = env::predecessor_account_id();
        let key = (employer.clone(), employee.clone());
        let mut entry = self
            .employees
            .get(&key)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Employee not registered"));
        entry.salary_commitment = salary_commitment.clone();
        entry.updated_at = env::block_timestamp();
        self.employees.insert(key, entry.clone());

        Event::EmployeeUpdated(vec![EmployeeUpdatedData {
            employer,
            employee,
            commitment_hash: salary_commitment,
            active: entry.active,
            at_ns: entry.updated_at,
        }])
        .emit();
    }

    /// Soft-deletes an employee while keeping the audit trail.
    pub fn deactivate_employee(&mut self, employee: AccountId) {
        Self::require_unpaused();

        let employer = env::predecessor_account_id();
        let key = (employer.clone(), employee.clone());
        let mut entry = self
            .employees
            .get(&key)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Employee not registered"));
        require!(entry.active, "Employee already inactive");
        entry.active = false;
        entry.updated_at = env::block_timestamp();
        self.employees.insert(key, entry.clone());

        Event::EmployeeUpdated(vec![EmployeeUpdatedData {
            employer,
            employee,
            commitment_hash: entry.salary_commitment,
            active: false,
            at_ns: entry.updated_at,
        }])
        .emit();
    }

    /// Returns the registry row, if any.
    pub fn get_employee(&self, employer: AccountId, employee: AccountId) -> Option<EmployeeEntry> {
        self.employees.get(&(employer, employee)).cloned()
    }

    /// Returns the number of registered employees for `employer`.
    pub fn get_employee_count(&self, employer: AccountId) -> u32 {
        self.employee_count.get(&employer).copied().unwrap_or(0)
    }

    /// Paginates the registry index. `limit` must be `1..=500`; an index past
    /// the end returns an empty vector.
    pub fn get_employees(
        &self,
        employer: AccountId,
        from_index: u32,
        limit: u32,
    ) -> Vec<AccountId> {
        require!(
            (1..=MAX_PAGE_LIMIT).contains(&limit),
            "limit must be between 1 and 500"
        );
        let ids = self
            .employee_ids
            .get(&employer)
            .cloned()
            .unwrap_or_default();
        ids.into_iter()
            .skip(from_index as usize)
            .take(limit as usize)
            .collect()
    }

    /// Returns whether the employee row exists (active or not).
    pub fn employee_exists(&self, employer: AccountId, employee: AccountId) -> bool {
        self.employees.contains_key(&(employer, employee))
    }

    // Salary commitments

    /// Stores one commitment hash for a (employee, cycle). The registered
    /// employee's token is recorded alongside. Requires a deposit covering
    /// [`COMMITMENT_RECORD_BYTES`]; re-committing an existing cycle overwrites
    /// the hash without increasing the count.
    #[payable]
    pub fn commit_salary(&mut self, employee: AccountId, commitment_hash: String, cycle_id: u64) {
        Self::require_unpaused();
        Self::assert_storage_deposit(COMMITMENT_RECORD_BYTES);
        Self::assert_commitment_hash(&commitment_hash);

        let employer = env::predecessor_account_id();
        let token = self
            .employees
            .get(&(employer.clone(), employee.clone()))
            .map(|entry| entry.token.clone())
            .unwrap_or_else(|| env::panic_str("Employee not registered"));

        let key = (employer.clone(), employee.clone(), cycle_id);
        let created_at = match self
            .commitments
            .get(&key)
            .map(|existing| existing.created_at)
        {
            Some(created_at) => created_at,
            None => {
                let count = self
                    .commitment_count
                    .get(&(employer.clone(), employee.clone()))
                    .copied()
                    .unwrap_or(0);
                self.commitment_count
                    .insert((employer.clone(), employee.clone()), count + 1);
                env::block_timestamp()
            }
        };
        self.commitments.insert(
            key,
            CommitmentEntry {
                commitment_hash: commitment_hash.clone(),
                token,
                created_at,
            },
        );

        Event::SalaryCommitted(vec![SalaryCommittedData {
            employer,
            employee,
            cycle_id,
            commitment_hash,
            at_ns: env::block_timestamp(),
        }])
        .emit();
    }

    /// Stores up to [`MAX_BATCH_COMMITS`] commitments in one call. All items
    /// are validated before the first write; the deposit must cover
    /// `items.len() * COMMITMENT_RECORD_BYTES`.
    #[payable]
    pub fn batch_commit_salaries(&mut self, items: Vec<CommitItem>) {
        Self::require_unpaused();
        require!(!items.is_empty(), "Batch must contain at least one item");
        require!(
            items.len() <= MAX_BATCH_COMMITS,
            "Batch exceeds the 50 commit cap"
        );
        Self::assert_storage_deposit(COMMITMENT_RECORD_BYTES.saturating_mul(items.len() as u64));

        let employer = env::predecessor_account_id();
        let mut prepared: Vec<(CommitItem, AccountId)> = Vec::with_capacity(items.len());
        for item in items {
            Self::assert_commitment_hash(&item.commitment_hash);
            let token = self
                .employees
                .get(&(employer.clone(), item.employee.clone()))
                .map(|entry| entry.token.clone())
                .unwrap_or_else(|| env::panic_str("Employee not registered"));
            prepared.push((item, token));
        }

        let now = env::block_timestamp();
        let mut events = Vec::with_capacity(prepared.len());
        for (item, token) in prepared {
            let key = (employer.clone(), item.employee.clone(), item.cycle_id);
            let created_at = match self
                .commitments
                .get(&key)
                .map(|existing| existing.created_at)
            {
                Some(created_at) => created_at,
                None => {
                    let count = self
                        .commitment_count
                        .get(&(employer.clone(), item.employee.clone()))
                        .copied()
                        .unwrap_or(0);
                    self.commitment_count
                        .insert((employer.clone(), item.employee.clone()), count + 1);
                    now
                }
            };
            self.commitments.insert(
                key,
                CommitmentEntry {
                    commitment_hash: item.commitment_hash.clone(),
                    token,
                    created_at,
                },
            );
            events.push(SalaryCommittedData {
                employer: employer.clone(),
                employee: item.employee,
                cycle_id: item.cycle_id,
                commitment_hash: item.commitment_hash,
                at_ns: now,
            });
        }
        Event::SalaryCommitted(events).emit();
    }

    /// Returns the commitment row for one cycle.
    pub fn get_commitment(
        &self,
        employer: AccountId,
        employee: AccountId,
        cycle_id: u64,
    ) -> Option<CommitmentEntry> {
        self.commitments
            .get(&(employer, employee, cycle_id))
            .cloned()
    }

    /// Returns the number of distinct cycles committed for one employee.
    pub fn get_commitment_count(&self, employer: AccountId, employee: AccountId) -> u32 {
        self.commitment_count
            .get(&(employer, employee))
            .copied()
            .unwrap_or(0)
    }

    // Payout lifecycle

    /// Schedules a payout for `execute_at` (nanoseconds). Returns the 1-based
    /// per-employer payout id. Requires a deposit covering
    /// [`PAYOUT_RECORD_BYTES`].
    #[payable]
    pub fn schedule_payout(
        &mut self,
        employee: AccountId,
        commitment_hash: String,
        asset: AccountId,
        memo: String,
        execute_at: u64,
    ) -> u64 {
        Self::require_unpaused();
        Self::assert_commitment_hash(&commitment_hash);
        require!(
            memo.len() <= MAX_MEMO_BYTES,
            "memo must be at most 256 bytes"
        );
        Self::assert_storage_deposit(PAYOUT_RECORD_BYTES + memo.len() as u64);

        let employer = env::predecessor_account_id();
        let mut ids = self.payout_ids.get(&employer).cloned().unwrap_or_default();
        require!(
            ids.len() < MAX_INDEX_ENTRIES as usize,
            "Payout index is capped at 500 per employer"
        );

        let payout_id = self
            .payout_seq
            .get(&employer)
            .copied()
            .unwrap_or(0)
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("Payout id space exhausted"));
        let now = env::block_timestamp();
        self.payouts.insert(
            (employer.clone(), payout_id),
            PayoutEntry {
                employer: employer.clone(),
                employee,
                commitment_hash,
                asset: asset.clone(),
                memo,
                execute_at,
                created_at: now,
                state: PayoutState::Pending,
                intent_hash: None,
            },
        );
        self.payout_seq.insert(employer.clone(), payout_id);
        ids.push(payout_id);
        self.payout_ids.insert(employer.clone(), ids);

        Event::PayoutScheduled(vec![PayoutScheduledData {
            employer,
            payout_id,
            asset,
            execute_at_ns: execute_at,
        }])
        .emit();

        payout_id
    }

    /// Cancels a pending payout. `reason_code` must be one of the origin SDK
    /// reason codes (`insufficient_funds`, `duplicate_run`, `employee_dispute`,
    /// `compliance_hold`, `schedule_error`, `other`).
    pub fn cancel_payout(&mut self, payout_id: u64, reason_code: String) {
        Self::require_unpaused();
        require!(
            is_cancellation_reason(&reason_code),
            "Unsupported cancellation reason code"
        );

        let employer = env::predecessor_account_id();
        let key = (employer.clone(), payout_id);
        let mut payout = self
            .payouts
            .get(&key)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Payout not found"));
        require!(
            payout.state == PayoutState::Pending,
            "Payout is not pending"
        );
        payout.state = PayoutState::Cancelled;
        self.payouts.insert(key, payout);

        Event::PayoutStateChanged(vec![PayoutStateChangedData {
            employer,
            payout_id,
            state: PayoutState::Cancelled,
            intent_hash: None,
        }])
        .emit();
    }

    /// Marks a pending payout settled (origin `SUCCESS`) and records the
    /// Confidential Intents hash.
    pub fn mark_settled(&mut self, payout_id: u64, intent_hash: String) {
        Self::require_unpaused();
        require!(
            is_valid_intent_hash(&intent_hash),
            "intent_hash must be 32-88 base58 characters"
        );

        let employer = env::predecessor_account_id();
        let key = (employer.clone(), payout_id);
        let mut payout = self
            .payouts
            .get(&key)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Payout not found"));
        require!(
            payout.state == PayoutState::Pending,
            "Payout is not pending"
        );
        payout.state = PayoutState::Executed;
        payout.intent_hash = Some(intent_hash.clone());
        self.payouts.insert(key, payout);

        Event::PayoutStateChanged(vec![PayoutStateChangedData {
            employer,
            payout_id,
            state: PayoutState::Executed,
            intent_hash: Some(intent_hash),
        }])
        .emit();
    }

    /// Marks a pending payout failed. `status` must be `FAILED` or `REFUNDED`,
    /// the terminal 1Click statuses that map to [`PayoutState::Failed`].
    pub fn mark_failed(&mut self, payout_id: u64, status: String) {
        Self::require_unpaused();
        require!(
            status == "FAILED" || status == "REFUNDED",
            "status must be FAILED or REFUNDED"
        );

        let employer = env::predecessor_account_id();
        let key = (employer.clone(), payout_id);
        let mut payout = self
            .payouts
            .get(&key)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Payout not found"));
        require!(
            payout.state == PayoutState::Pending,
            "Payout is not pending"
        );
        payout.state = PayoutState::Failed;
        self.payouts.insert(key, payout);

        Event::PayoutStateChanged(vec![PayoutStateChangedData {
            employer,
            payout_id,
            state: PayoutState::Failed,
            intent_hash: None,
        }])
        .emit();
    }

    /// Moves a pending payout to [`PayoutState::Expired`] once
    /// `now >= execute_at + GRACE_NS`.
    pub fn expire_payout(&mut self, payout_id: u64) {
        Self::require_unpaused();

        let employer = env::predecessor_account_id();
        let key = (employer.clone(), payout_id);
        let mut payout = self
            .payouts
            .get(&key)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Payout not found"));
        require!(
            payout.state == PayoutState::Pending,
            "Payout is not pending"
        );
        require!(
            env::block_timestamp() >= payout.execute_at.saturating_add(GRACE_NS),
            "Payout cannot be expired yet"
        );
        payout.state = PayoutState::Expired;
        self.payouts.insert(key, payout);

        Event::PayoutStateChanged(vec![PayoutStateChangedData {
            employer,
            payout_id,
            state: PayoutState::Expired,
            intent_hash: None,
        }])
        .emit();
    }

    /// Returns one payout row.
    pub fn get_payout(&self, employer: AccountId, payout_id: u64) -> Option<PayoutEntry> {
        self.payouts.get(&(employer, payout_id)).cloned()
    }

    /// Paginates the payout index and returns pending rows. `limit` must be
    /// `1..=500`; an index past the end returns an empty vector.
    pub fn get_pending_payouts(
        &self,
        employer: AccountId,
        from_index: u32,
        limit: u32,
    ) -> Vec<PayoutEntry> {
        require!(
            (1..=MAX_PAGE_LIMIT).contains(&limit),
            "limit must be between 1 and 500"
        );
        let ids = self.payout_ids.get(&employer).cloned().unwrap_or_default();
        ids.into_iter()
            .skip(from_index as usize)
            .filter_map(|payout_id| {
                self.payouts
                    .get(&(employer.clone(), payout_id))
                    .filter(|payout| payout.state == PayoutState::Pending)
                    .cloned()
            })
            .take(limit as usize)
            .collect()
    }

    /// Returns the number of payouts ever scheduled for `employer`.
    pub fn get_payout_count(&self, employer: AccountId) -> u32 {
        self.payout_seq.get(&employer).copied().unwrap_or(0) as u32
    }

    /// Returns whether a payout is pending and `execute_at` has been reached.
    pub fn is_payout_due(&self, employer: AccountId, payout_id: u64) -> bool {
        self.payouts
            .get(&(employer, payout_id))
            .map(|payout| {
                payout.state == PayoutState::Pending && env::block_timestamp() >= payout.execute_at
            })
            .unwrap_or(false)
    }

    // Holds and auditor roles

    /// Places an active audit hold. Authorized for the employer or one of its
    /// auditors. `reason_code` must be one of the seven uppercase codes.
    /// Requires a deposit covering [`HOLD_RECORD_BYTES`].
    #[payable]
    pub fn create_audit_hold(
        &mut self,
        hold_id: String,
        employer: AccountId,
        scope: HoldScope,
        scope_id: String,
        reason_code: String,
    ) {
        Self::require_unpaused();
        require!(
            !hold_id.is_empty() && hold_id.len() <= MAX_HOLD_ID_BYTES,
            "hold_id must be 1..=128 bytes"
        );
        require!(
            !scope_id.is_empty() && scope_id.len() <= MAX_HOLD_ID_BYTES,
            "scope_id must be 1..=128 bytes"
        );
        Self::assert_storage_deposit(HOLD_RECORD_BYTES + (hold_id.len() + scope_id.len()) as u64);
        let reason = parse_hold_reason(&reason_code)
            .unwrap_or_else(|| env::panic_str("Unknown hold reason code"));

        let caller = env::predecessor_account_id();
        require!(
            caller == employer || self.is_auditor(&employer, &caller),
            "Only the employer or an auditor can create a hold"
        );
        require!(!self.holds.contains_key(&hold_id), "Hold already exists");

        let now = env::block_timestamp();
        self.holds.insert(
            hold_id.clone(),
            HoldEntry {
                employer: employer.clone(),
                scope: scope.clone(),
                scope_id,
                reason_code: reason,
                state: HoldState::Active,
                placed_by: caller.clone(),
                placed_at: now,
                released_by: None,
                released_at: None,
                release_reason: None,
            },
        );
        let mut ids = self.hold_ids.get(&employer).cloned().unwrap_or_default();
        require!(
            ids.len() < MAX_INDEX_ENTRIES as usize,
            "Hold index is capped at 500 per employer"
        );
        ids.push(hold_id.clone());
        self.hold_ids.insert(employer.clone(), ids);

        Event::AuditHoldChanged(vec![AuditHoldChangedData {
            hold_id,
            employer,
            scope,
            state: HoldState::Active,
            by: caller,
        }])
        .emit();
    }

    /// Returns the hold row, if any.
    pub fn get_audit_hold(&self, hold_id: String) -> Option<HoldEntry> {
        self.holds.get(&hold_id).cloned()
    }

    /// Returns the per-employer hold-id index, paginated like the other
    /// index views (`1..=500`).
    pub fn get_hold_ids(&self, employer: AccountId, from_index: u32, limit: u32) -> Vec<String> {
        require!(
            (1..=MAX_PAGE_LIMIT).contains(&limit),
            "limit must be between 1 and 500"
        );
        let ids = self.hold_ids.get(&employer).cloned().unwrap_or_default();
        ids.into_iter()
            .skip(from_index as usize)
            .take(limit as usize)
            .collect()
    }

    /// Releases an active hold. Authorized for the employer or one of its
    /// auditors; records the predecessor and timestamp.
    pub fn release_audit_hold(&mut self, hold_id: String, release_reason: String) {
        Self::require_unpaused();
        let reason = parse_hold_reason(&release_reason)
            .unwrap_or_else(|| env::panic_str("Unknown hold reason code"));

        let caller = env::predecessor_account_id();
        let mut hold = self
            .holds
            .get(&hold_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Hold not found"));
        require!(hold.state == HoldState::Active, "Hold is not active");
        require!(
            caller == hold.employer || self.is_auditor(&hold.employer, &caller),
            "Only the employer or an auditor can release a hold"
        );

        let now = env::block_timestamp();
        hold.state = HoldState::Released;
        hold.released_by = Some(caller.clone());
        hold.released_at = Some(now);
        hold.release_reason = Some(reason);
        self.holds.insert(hold_id.clone(), hold.clone());

        Event::AuditHoldChanged(vec![AuditHoldChangedData {
            hold_id,
            employer: hold.employer,
            scope: hold.scope,
            state: HoldState::Released,
            by: caller,
        }])
        .emit();
    }

    /// Grants an auditor role for `employer`. Callable by the employer or the
    /// contract owner.
    pub fn grant_auditor(&mut self, employer: AccountId, auditor: AccountId) {
        Self::require_unpaused();
        let caller = env::predecessor_account_id();
        if caller != employer {
            Self::require_owner();
        }
        let added = self
            .auditors
            .entry(employer.clone())
            .or_insert_with(|| LookupSet::new(StorageKey::AuditorSet(employer.clone())))
            .insert(auditor.clone());
        if added {
            Event::AuditorChanged(vec![AuditorChangedData {
                employer,
                auditor,
                granted: true,
            }])
            .emit();
        }
    }

    /// Revokes an auditor role for `employer`. Callable by the employer or the
    /// contract owner.
    pub fn revoke_auditor(&mut self, employer: AccountId, auditor: AccountId) {
        Self::require_unpaused();
        let caller = env::predecessor_account_id();
        if caller != employer {
            Self::require_owner();
        }
        let removed = self
            .auditors
            .get_mut(&employer)
            .map(|auditors| auditors.remove(&auditor))
            .unwrap_or(false);
        if removed {
            Event::AuditorChanged(vec![AuditorChangedData {
                employer,
                auditor,
                granted: false,
            }])
            .emit();
        }
    }

    /// Toggles the single global pause. Owner only; the only mutator that is
    /// callable while paused.
    pub fn set_pause(&mut self, paused: bool) {
        Self::require_owner();
        self.set_is_paused(paused);
    }

    // Groth16 verification (implemented in `groth16.rs`)
}
