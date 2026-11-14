//! NEP-297 events for the subrosa contract.
//!
//! The standard name is declared once on [`Event`]; every variant carries an
//! explicit version. Payload structs are wrapped in `Vec<_>` so the `data` field
//! is always a JSON array. Every `*_ns` field is `env::block_timestamp()`.

use near_sdk::{AccountId, near};

use crate::{HoldScope, HoldState, PayoutState};

/// A new employee row was registered.
#[near(serializers = [json])]
#[derive(Clone)]
pub struct EmployeeRegisteredData {
    pub employer: AccountId,
    pub employee: AccountId,
    pub token: AccountId,
    pub commitment_hash: String,
    pub at_ns: u64,
}

/// An employee row changed commitment or active flag.
#[near(serializers = [json])]
#[derive(Clone)]
pub struct EmployeeUpdatedData {
    pub employer: AccountId,
    pub employee: AccountId,
    pub commitment_hash: String,
    pub active: bool,
    pub at_ns: u64,
}

/// A salary commitment was stored for a cycle.
#[near(serializers = [json])]
#[derive(Clone)]
pub struct SalaryCommittedData {
    pub employer: AccountId,
    pub employee: AccountId,
    pub cycle_id: u64,
    pub commitment_hash: String,
    pub at_ns: u64,
}

/// An auditor role was granted or revoked.
#[near(serializers = [json])]
#[derive(Clone)]
pub struct AuditorChangedData {
    pub employer: AccountId,
    pub auditor: AccountId,
    pub granted: bool,
}

/// A payout was scheduled.
#[near(serializers = [json])]
#[derive(Clone)]
pub struct PayoutScheduledData {
    pub employer: AccountId,
    pub payout_id: u64,
    pub asset: AccountId,
    pub execute_at_ns: u64,
}

/// A payout moved state; `intent_hash` is present once settlement reports back.
#[near(serializers = [json])]
#[derive(Clone)]
pub struct PayoutStateChangedData {
    pub employer: AccountId,
    pub payout_id: u64,
    pub state: PayoutState,
    pub intent_hash: Option<String>,
}

/// An audit hold was placed or released.
#[near(serializers = [json])]
#[derive(Clone)]
pub struct AuditHoldChangedData {
    pub hold_id: String,
    pub employer: AccountId,
    pub scope: HoldScope,
    pub state: HoldState,
    pub by: AccountId,
}

/// A Groth16 proof verified and its nullifier was consumed.
#[near(serializers = [json])]
#[derive(Clone)]
pub struct ProofVerifiedData {
    pub vk_id: u32,
    pub nullifier: String,
}

#[near(event_json(standard = "subrosa"))]
pub enum Event {
    #[event_version("1.0.0")]
    EmployeeRegistered(Vec<EmployeeRegisteredData>),
    #[event_version("1.0.0")]
    EmployeeUpdated(Vec<EmployeeUpdatedData>),
    #[event_version("1.0.0")]
    SalaryCommitted(Vec<SalaryCommittedData>),
    #[event_version("1.0.0")]
    AuditorChanged(Vec<AuditorChangedData>),
    #[event_version("1.0.0")]
    PayoutScheduled(Vec<PayoutScheduledData>),
    #[event_version("1.0.0")]
    PayoutStateChanged(Vec<PayoutStateChangedData>),
    #[event_version("1.0.0")]
    AuditHoldChanged(Vec<AuditHoldChangedData>),
    #[event_version("1.0.0")]
    ProofVerified(Vec<ProofVerifiedData>),
}
