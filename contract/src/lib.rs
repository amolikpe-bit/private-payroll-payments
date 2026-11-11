//! subrosa payroll contract: employer/employee registry, salary commitments,
//! scheduled payouts, and audit holds.
//!
//! Chain state is public: salaries never appear on chain, only commitments.
//! Settlement runs off chain over Confidential Intents and is reported back via
//! the payout lifecycle methods. Every timestamp is `env::block_timestamp()`
//! (nanoseconds since the epoch).

use near_sdk::borsh::BorshSerialize;
use near_sdk::store::{IterableMap, LookupMap, LookupSet};
use near_sdk::{near, AccountId, BorshStorageKey};

pub mod events;

/// Contract state.
///
/// `owner` deploys the contract and holds the global admin switches. Every other
/// collection is keyed by employer so per-employer views never need a prefix
/// scan; the matching `*_count` / `*_ids` collections carry the small per
/// employer indexes.
#[near(contract_state)]
pub struct Contract {
    owner: AccountId,
    /// (employer, employee) registry.
    employees: IterableMap<(AccountId, AccountId), EmployeeEntry>,
    /// Per-employer registry size.
    employee_count: LookupMap<AccountId, u32>,
    /// Per-employer registry index (capped at ~500 entries).
    employee_ids: LookupMap<AccountId, Vec<AccountId>>,
    commitments: LookupMap<(AccountId, AccountId, u64), CommitmentEntry>,
    /// Per (employer, employee) commitment count across cycles.
    commitment_count: LookupMap<(AccountId, AccountId), u32>,
    /// Payout rows keyed by (employer, payout id).
    payouts: LookupMap<(AccountId, u64), PayoutEntry>,
    /// Per-employer payout id sequence.
    payout_seq: LookupMap<AccountId, u64>,
    /// Per-employer payout id index (capped at ~500 entries).
    payout_ids: LookupMap<AccountId, Vec<u64>>,
    holds: LookupMap<String, HoldEntry>,
    /// Per-employer hold id index.
    hold_ids: LookupMap<AccountId, Vec<String>>,
    /// employer -> auditors allowed to read holds and place them.
    auditors: LookupMap<AccountId, LookupSet<AccountId>>,
    /// Global pause; only the owner can flip it.
    paused: bool,
    vks: LookupMap<u32, VerificationKeyInfo>,
    active_vk: u32,
    used_proofs: LookupSet<[u8; 32]>,
}

/// Registry row. `salary_commitment` is the hex commitment preimage digest; the
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

/// Commitment row for one (employer, employee, cycle) triple.
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
#[derive(Clone, PartialEq)]
pub enum PayoutState {
    Pending,
    Executed,
    Cancelled,
    Expired,
    Failed,
}

/// Audit hold row. `released_by` / `released_at` / `release_reason` are set only
/// when the hold moves to `HoldState::Released`.
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
#[derive(Clone, PartialEq)]
pub enum HoldScope {
    Employer,
    Period,
    Batch,
    Employee,
}

/// Hold lifecycle state.
#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq)]
pub enum HoldState {
    Active,
    Released,
}

/// Closed set of safe, non-identifying hold reasons. Variant names map one to
/// one onto the SDK's reason codes: `KYC_REVIEW_PENDING`, `SANCTIONS_SCREENING`,
/// `TAX_WITHHOLDING_DISCREPANCY`, `REGULATORY_INVESTIGATION`,
/// `DUPLICATE_PAYMENT_SUSPECTED`, `MANUAL_REVIEW_REQUESTED`, `OTHER`.
#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq)]
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
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct VerificationKeyInfo {
    pub key: Vec<u8>,
    pub description: String,
}

/// One registry-plus-commitment item for a batch commit.
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct CommitItem {
    pub employee: AccountId,
    pub commitment_hash: String,
    pub cycle_id: u64,
}

/// Collection prefixes. Each variant serializes to a distinct byte string, so
/// separate collections never share a key space; variant order follows the
/// data-model table (`r/c/p/h/n/v` are logical families, not ASCII bytes).
/// `AuditorSet` nests a per-employer set under the `auditors` map and must stay
/// distinct per employer.
#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
pub enum StorageKey {
    /// `r`: (employer, employee) registry.
    Employees,
    /// Per-employer registry counter.
    EmployeeCount,
    /// Per-employer registry index.
    EmployeeIds,
    /// `c`: (employer, employee, cycle) commitments.
    Commitments,
    /// Per (employer, employee) commitment counter.
    CommitmentCount,
    /// `p`: (employer, payout id) payouts.
    Payouts,
    /// Per-employer payout id sequence.
    PayoutSeq,
    /// Per-employer payout id index.
    PayoutIds,
    /// `h`: hold id -> hold row.
    Holds,
    /// Per-employer hold id index.
    HoldIds,
    /// employer -> auditor set.
    Auditors,
    /// Per-employer auditor set nested under `auditors`.
    AuditorSet(AccountId),
    /// `v`: verification key id -> key info.
    VerificationKeys,
    /// `n`: spent proof nullifiers.
    UsedProofs,
}

#[near]
impl Contract {
    /// Deployer sets the owner. Every collection gets its own prefix and the
    /// global switches start unpaused with no active verification key.
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self {
            owner,
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
            paused: false,
            vks: LookupMap::new(StorageKey::VerificationKeys),
            active_vk: 0,
            used_proofs: LookupSet::new(StorageKey::UsedProofs),
        }
    }
}
