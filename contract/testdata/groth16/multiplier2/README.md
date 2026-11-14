# Groth16 fixture: circom `multiplier2`

These `snarkjs` artifacts cover the two-input multiplier circuit (`c = a * b`).
The proof shows private witness `a = 3`, `b = 11` for public output `c = 33`. `public.json` holds `["33"]`.
Files come from <https://github.com/k-gunjan/circom-snarkjs-webAssembly-groth16-zk-SNARK-protocol>. The proof passes `snarkjs@0.7.6` (`groth16 verify` prints `OK!`).

Unit tests build NEAR wire bytes from these JSON files and call `env::alt_bn128_*`. The fixture is an executable proof, not docs only.

## Files

| File | Shape |
|---|---|
| `proof.json` | `{ "pi_a": [x, y, "1"], "pi_b": [[x_re, x_im], [y_re, y_im], ["1", "0"]], "pi_c": [x, y, "1"], "protocol": "groth16", "curve": "bn128" }` |
| `public.json` | JSON array of decimal public signals, here `["33"]` |
| `verification_key.json` | `{ "protocol", "curve", "nPublic", "vk_alpha_1", "vk_beta_2", "vk_gamma_2", "vk_delta_2", "vk_alphabeta_12", "IC": [...] }` |

`pi_a` / `pi_c` / `IC[i]` are G1 points. `pi_b` and the `vk_*_2` values are G2 points in snarkjs order: `[[x_re, x_im], [y_re, y_im], ["1", "0"]]`.

## Reproduce the fixture

```bash
npm i --save-exact snarkjs@0.7.6
# multiplier2.circom:
#   pragma circom 2.0.0;
#   template Multiplier2() {
#     signal input a;
#     signal input b;
#     signal output c;
#     c <== a * b;
#   }
#   component main = Multiplier2();
circom multiplier2.circom --r1cs --wasm --sym

# powersOfTau28_hez_final_08.ptau is the Hermez phase-1 file
# (blake2b d6a8fb3a...); prepare it for phase 2:
snarkjs powersoftau prepare phase2 powersOfTau28_hez_final_08.ptau pot08_final.ptau -v

snarkjs groth16 setup multiplier2.r1cs pot08_final.ptau multiplier2_0000.zkey
snarkjs zkey contribute multiplier2_0000.zkey multiplier2_final.zkey \
  --name="subrosa fixture" -v -e="subrosa fixture entropy"
snarkjs zkey export verificationkey multiplier2_final.zkey verification_key.json

# input.json: { "a": "3", "b": "11" }
snarkjs groth16 fullprove input.json multiplier2.wasm multiplier2_final.zkey \
  proof.json public.json
snarkjs groth16 verify verification_key.json public.json proof.json
```

## NEAR wire encoding used by the contract

All field elements are 32-byte **little-endian** integers. There is no EIP-197 big-endian encoding and no EVM `[1]`/`[0]` coordinate swap.

`proof_bytes` (256 B):

```text
A (G1): x ‖ y                                         64 B
B (G2): x_re ‖ x_im ‖ y_re ‖ y_im                    128 B
C (G1): x ‖ y                                         64 B
```

`vk_bytes`:

```text
alpha (G1): x ‖ y                                     64 B
beta  (G2): x_re ‖ x_im ‖ y_re ‖ y_im               128 B
gamma (G2): x_re ‖ x_im ‖ y_re ‖ y_im               128 B
delta (G2): x_re ‖ x_im ‖ y_re ‖ y_im               128 B
ic_count: u32 little-endian                            4 B
IC[0] .. IC[ic_count-1] (G1, 64 B each)
```

The verifier negates A as `(x, p - y)`, keeping `(0, 0)` at infinity. It computes `vk_x = IC[0] + sum(pub[i] * IC[i+1])` via `alt_bn128_g1_multiexp` and `alt_bn128_g1_sum`. It then calls `alt_bn128_pairing_check` on `[(-A, B), (alpha, beta), (vk_x, gamma), (C, delta)]`.

This fixture is the `multiplier2` circuit, so `ic_count = 2` and the only public input is `"33"`.
