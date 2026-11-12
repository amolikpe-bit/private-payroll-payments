//! Optional Groth16 attestation verifier built on NEAR's `alt_bn128` host
//! functions (protocol version 55+, `near-sdk` >= 5.0).
//!
//! This module is attestation only: money still moves over Confidential
//! Intents, and a verified proof consumes a nullifier but moves no funds.
//!
//! # Wire formats
//!
//! These are NEAR host-function encodings, **not** EIP-197/EVM calldata. All
//! field elements are 32-byte little-endian integers with no length prefix.
//!
//! `proof_bytes` (exactly [`PROOF_BYTES`] = 256 bytes):
//!
//! ```text
//! A (G1, 64 B = x ‖ y) ‖ B (G2, 128 B = x_re ‖ x_im ‖ y_re ‖ y_im) ‖ C (G1, 64 B)
//! ```
//!
//! `vk_bytes` ([`VK_HEADER_BYTES`] + `ic_count * 64` bytes):
//!
//! ```text
//! alpha  (G1, 64 B)
//! beta   (G2, 128 B)
//! gamma  (G2, 128 B)
//! delta  (G2, 128 B)
//! ic_count (u32 little-endian)
//! IC[0] .. IC[ic_count-1] (G1, 64 B each)
//! ```
//!
//! `public_inputs` are decimal strings; each is parsed into one 32-byte
//! little-endian scalar field element. The verifier computes
//! `vk_x = IC[0] + sum(pub[i] * IC[i+1])` through
//! [`env::alt_bn128_g1_multiexp`] and [`env::alt_bn128_g1_sum`] (96-byte
//! `G1 ‖ Fr` chunks and 65-byte `sign ‖ G1` chunks respectively), then checks
//! the four raw 192-byte pairs `[(-A, B), (alpha, beta), (vk_x, gamma),
//! (C, delta)]` with [`env::alt_bn128_pairing_check`]. G1 negation is
//! `(x, p - y)`; Fq2 is encoded real then imaginary. snarkjs JSON coordinate
//! order is kept as-is (there is no EVM `[1]`/`[0]` swap).

use near_sdk::{env, near, require};
use near_sdk_contract_tools::owner::Owner;
use near_sdk_contract_tools::pause::Pause;

use crate::events::{Event, ProofVerifiedData};
use crate::{
    hex_decode, hex_encode, Contract, ContractExt, VerificationKeyInfo,
    MAX_VK_DESCRIPTION_BYTES, NULLIFIER_RECORD_BYTES,
};

/// Bytes in a G1 point (`x ‖ y`).
pub const G1_BYTES: usize = 64;
/// Bytes in a G2 point (`x_re ‖ x_im ‖ y_re ‖ y_im`).
pub const G2_BYTES: usize = 128;
/// Bytes in one raw pairing-check element (`G1 ‖ G2`).
pub const PAIRING_ELEMENT_BYTES: usize = G1_BYTES + G2_BYTES;
/// Bytes in one `alt_bn128_g1_multiexp` element (`G1 ‖ Fr`).
pub const MULTIEXP_ELEMENT_BYTES: usize = G1_BYTES + 32;
/// Bytes in one `alt_bn128_g1_sum` element (`sign ‖ G1`).
pub const G1_SUM_ELEMENT_BYTES: usize = 1 + G1_BYTES;
/// Bytes in a serialized Groth16 proof.
pub const PROOF_BYTES: usize = G1_BYTES + G2_BYTES + G1_BYTES;
/// Bytes preceding the `IC` array in a serialized verification key.
pub const VK_HEADER_BYTES: usize = G1_BYTES + 3 * G2_BYTES + 4;

/// Base field modulus `p` for alt_bn128, little-endian.
const FIELD_MODULUS: [u8; 32] = [
    0x47, 0xfd, 0x7c, 0xd8, 0x16, 0x8c, 0x20, 0x3c, 0x8d, 0xca, 0x71, 0x68, 0x91, 0x6a, 0x81, 0x97,
    0x5d, 0x58, 0x81, 0x81, 0xb6, 0x45, 0x50, 0xb8, 0x29, 0xa0, 0x31, 0xe1, 0x72, 0x4e, 0x64, 0x30,
];

/// Scalar field modulus `r` for alt_bn128, little-endian.
const SCALAR_MODULUS: [u8; 32] = [
    0x01, 0x00, 0x00, 0xf0, 0x93, 0xf5, 0xe1, 0x43, 0x91, 0x70, 0xb9, 0x79, 0x48, 0xe8, 0x33, 0x28,
    0x5d, 0x58, 0x81, 0x81, 0xb6, 0x45, 0x50, 0xb8, 0x29, 0xa0, 0x31, 0xe1, 0x72, 0x4e, 0x64, 0x30,
];

/// Parsed proof slices.
struct Proof<'a> {
    a: &'a [u8],
    b: &'a [u8],
    c: &'a [u8],
}

/// Parsed verification key slices.
struct VerificationKey<'a> {
    alpha: &'a [u8],
    beta: &'a [u8],
    gamma: &'a [u8],
    delta: &'a [u8],
    ic: Vec<&'a [u8]>,
}

/// Negates a canonical base-field element: `0 -> 0`, else `p - value`.
pub(crate) fn field_neg(value: &[u8; 32]) -> Option<[u8; 32]> {
    if !lt_le(value, &FIELD_MODULUS) {
        return None;
    }
    if value.iter().all(|byte| *byte == 0) {
        return Some([0u8; 32]);
    }
    let mut out = [0u8; 32];
    let mut borrow = 0i16;
    for index in 0..32 {
        let difference = i16::from(FIELD_MODULUS[index]) - i16::from(value[index]) - borrow;
        if difference < 0 {
            out[index] = (difference + 256) as u8;
            borrow = 1;
        } else {
            out[index] = difference as u8;
            borrow = 0;
        }
    }
    Some(out)
}

/// Parses one decimal string into a 32-byte little-endian unsigned integer.
/// Rejects empty/non-decimal input and values >= 2^256.
pub(crate) fn parse_decimal_u256(text: &str) -> Option<[u8; 32]> {
    let bytes = text.as_bytes();
    if bytes.is_empty() || bytes.len() > 78 {
        return None;
    }
    let mut out = [0u8; 32];
    for &byte in bytes {
        if !byte.is_ascii_digit() {
            return None;
        }
        let mut carry = u32::from(byte - b'0');
        for limb in out.iter_mut() {
            let value = u32::from(*limb) * 10 + carry;
            *limb = value as u8;
            carry = value >> 8;
        }
        if carry != 0 {
            return None;
        }
    }
    Some(out)
}

/// Parses one decimal string into a canonical 32-byte little-endian `Fr`
/// element. Rejects input that is not a canonical scalar (`>= r`).
pub(crate) fn parse_decimal_fr(text: &str) -> Option<[u8; 32]> {
    let value = parse_decimal_u256(text)?;
    if lt_le(&value, &SCALAR_MODULUS) {
        Some(value)
    } else {
        None
    }
}

/// Negates a G1 point by negating its `y` coordinate; infinity maps to itself.
pub(crate) fn g1_neg(point: &[u8; 64]) -> Option<[u8; 64]> {
    let x: [u8; 32] = point[..32].try_into().ok()?;
    let y: [u8; 32] = point[32..].try_into().ok()?;
    if !lt_le(&x, &FIELD_MODULUS) {
        return None;
    }
    let neg_y = field_neg(&y)?;
    let mut out = [0u8; 64];
    out[..32].copy_from_slice(&x);
    out[32..].copy_from_slice(&neg_y);
    Some(out)
}

/// Returns whether a serialized verification key has a valid shape.
pub(crate) fn validate_verification_key(bytes: &[u8]) -> bool {
    parse_vk(bytes).is_some()
}

/// Verifies a Groth16 proof against the raw public inputs.
pub(crate) fn verify_groth16(
    proof_bytes: &[u8],
    public_inputs: &[String],
    vk_bytes: &[u8],
) -> bool {
    let Some(proof) = parse_proof(proof_bytes) else {
        return false;
    };
    let Some(vk) = parse_vk(vk_bytes) else {
        return false;
    };
    if vk.ic.len() != public_inputs.len() + 1 {
        return false;
    }

    let mut scalars = Vec::with_capacity(public_inputs.len());
    for input in public_inputs {
        match parse_decimal_fr(input) {
            Some(scalar) => scalars.push(scalar),
            None => return false,
        }
    }

    let vk_x = if scalars.is_empty() {
        vk.ic[0].to_vec()
    } else {
        let mut multiexp = Vec::with_capacity(scalars.len() * MULTIEXP_ELEMENT_BYTES);
        for (index, scalar) in scalars.iter().enumerate() {
            multiexp.extend_from_slice(vk.ic[index + 1]);
            multiexp.extend_from_slice(scalar);
        }
        let contribution = env::alt_bn128_g1_multiexp(&multiexp);
        if contribution.len() != G1_BYTES {
            return false;
        }
        let mut sum = Vec::with_capacity(2 * G1_SUM_ELEMENT_BYTES);
        sum.push(0u8);
        sum.extend_from_slice(vk.ic[0]);
        sum.push(0u8);
        sum.extend_from_slice(&contribution);
        let combined = env::alt_bn128_g1_sum(&sum);
        if combined.len() != G1_BYTES {
            return false;
        }
        combined
    };

    let a: [u8; G1_BYTES] = match proof.a.try_into() {
        Ok(point) => point,
        Err(_) => return false,
    };
    let neg_a = match g1_neg(&a) {
        Some(point) => point,
        None => return false,
    };

    let mut pairs = Vec::with_capacity(4 * PAIRING_ELEMENT_BYTES);
    pairs.extend_from_slice(&neg_a);
    pairs.extend_from_slice(proof.b);
    pairs.extend_from_slice(vk.alpha);
    pairs.extend_from_slice(vk.beta);
    pairs.extend_from_slice(&vk_x);
    pairs.extend_from_slice(vk.gamma);
    pairs.extend_from_slice(proof.c);
    pairs.extend_from_slice(vk.delta);
    env::alt_bn128_pairing_check(&pairs)
}

fn parse_proof(bytes: &[u8]) -> Option<Proof<'_>> {
    if bytes.len() != PROOF_BYTES {
        return None;
    }
    let a = &bytes[..G1_BYTES];
    let b = &bytes[G1_BYTES..G1_BYTES + G2_BYTES];
    let c = &bytes[G1_BYTES + G2_BYTES..];
    if !canonical_point(a) || !canonical_point(b) || !canonical_point(c) {
        return None;
    }
    Some(Proof { a, b, c })
}

fn parse_vk(bytes: &[u8]) -> Option<VerificationKey<'_>> {
    if bytes.len() < VK_HEADER_BYTES {
        return None;
    }
    let ic_count = u32::from_le_bytes(bytes[VK_HEADER_BYTES - 4..VK_HEADER_BYTES].try_into().ok()?)
        as usize;
    if ic_count == 0 {
        return None;
    }
    let expected = ic_count
        .checked_mul(G1_BYTES)?
        .checked_add(VK_HEADER_BYTES)?;
    if bytes.len() != expected {
        return None;
    }
    let alpha = &bytes[..G1_BYTES];
    let beta = &bytes[G1_BYTES..G1_BYTES + G2_BYTES];
    let gamma = &bytes[G1_BYTES + G2_BYTES..G1_BYTES + 2 * G2_BYTES];
    let delta = &bytes[G1_BYTES + 2 * G2_BYTES..G1_BYTES + 3 * G2_BYTES];
    if !canonical_point(alpha)
        || !canonical_point(beta)
        || !canonical_point(gamma)
        || !canonical_point(delta)
    {
        return None;
    }
    let mut ic = Vec::with_capacity(ic_count);
    let mut offset = VK_HEADER_BYTES;
    for _ in 0..ic_count {
        let point = &bytes[offset..offset + G1_BYTES];
        if !canonical_point(point) {
            return None;
        }
        ic.push(point);
        offset += G1_BYTES;
    }
    Some(VerificationKey {
        alpha,
        beta,
        gamma,
        delta,
        ic,
    })
}

/// Checks that a serialized G1/G2 point is a whole number of canonical field
/// elements. Curve membership is enforced by the host functions.
fn canonical_point(point: &[u8]) -> bool {
    point.len() % 32 == 0 && point.chunks_exact(32).all(is_canonical_fq)
}

fn is_canonical_fq(raw: &[u8]) -> bool {
    let value: [u8; 32] = match raw.try_into() {
        Ok(value) => value,
        Err(_) => return false,
    };
    lt_le(&value, &FIELD_MODULUS)
}

/// Little-endian 256-bit `a < b`.
fn lt_le(a: &[u8; 32], b: &[u8; 32]) -> bool {
    for index in (0..32).rev() {
        if a[index] != b[index] {
            return a[index] < b[index];
        }
    }
    false
}

#[near]
impl Contract {
    /// Verifies a Groth16 proof and consumes its nullifier
    /// (`sha256(proof_bytes)`). Returns `false` for an unknown verification key
    /// or malformed/non-canonical wire input; panics with `ProofAlreadyUsed`
    /// when the nullifier was already consumed. Requires a deposit covering
    /// [`NULLIFIER_RECORD_BYTES`]; the deposit is retained.
    #[payable]
    pub fn verify_proof(
        &mut self,
        proof_bytes: Vec<u8>,
        public_inputs: Vec<String>,
        verification_key_id: u32,
    ) -> bool {
        Self::require_unpaused();

        let vk_bytes = match self
            .vks
            .get(&verification_key_id)
            .and_then(|info| hex_decode(&info.key))
        {
            Some(bytes) => bytes,
            None => return false,
        };
        Self::assert_storage_deposit(NULLIFIER_RECORD_BYTES);

        if proof_bytes.len() != PROOF_BYTES {
            return false;
        }
        let mut nullifier = [0u8; 32];
        nullifier.copy_from_slice(&env::sha256(&proof_bytes));
        require!(
            !self.used_proofs.contains(&nullifier),
            "ProofAlreadyUsed"
        );

        if !verify_groth16(&proof_bytes, &public_inputs, &vk_bytes) {
            return false;
        }

        self.used_proofs.insert(nullifier);
        Event::ProofVerified(vec![ProofVerifiedData {
            vk_id: verification_key_id,
            nullifier: hex_encode(&nullifier),
        }])
        .emit();
        true
    }

    /// Registers a verification key and returns its id (1-based). Owner only.
    /// The key is stored hex encoded so the JSON shape matches the SDK's
    /// `VerificationKeyInfo`.
    pub fn add_verification_key(&mut self, vk_bytes: Vec<u8>, description: String) -> u32 {
        Self::require_owner();
        Self::require_unpaused();
        require!(
            description.len() <= MAX_VK_DESCRIPTION_BYTES,
            "description must be at most 256 bytes"
        );
        require!(
            validate_verification_key(&vk_bytes),
            "Invalid verification key encoding"
        );
        let id = self
            .vk_count
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("Verification key id space exhausted"));
        self.vk_count = id;
        self.vks.insert(
            id,
            VerificationKeyInfo {
                key: hex_encode(&vk_bytes),
                description,
            },
        );
        id
    }

    /// Activates an existing verification key. Owner only.
    pub fn set_active_verification_key(&mut self, id: u32) {
        Self::require_owner();
        Self::require_unpaused();
        require!(
            self.vks.contains_key(&id),
            "Unknown verification key id"
        );
        self.active_vk = id;
    }

    /// Returns the raw verification-key bytes (`None` for an unknown id).
    pub fn get_verification_key(&self, id: u32) -> Option<Vec<u8>> {
        self.vks.get(&id).and_then(|info| hex_decode(&info.key))
    }

    /// Returns the verification key and its description (`None` for an
    /// unknown id).
    pub fn get_verification_key_info(&self, id: u32) -> Option<VerificationKeyInfo> {
        self.vks.get(&id).cloned()
    }

    /// Returns the active verification key id, or 0 when none is active.
    pub fn get_active_verification_key_id(&self) -> u32 {
        self.active_vk
    }

    /// Returns the number of registered verification keys.
    pub fn get_verification_key_count(&self) -> u32 {
        self.vk_count
    }
}
