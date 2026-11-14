# Attribution

subrosa is a port of the MIT-licensed zk-payroll SDK to NEAR.

## Origin

- Project: `zkpayroll/zk-payroll-sdk`
- Source: https://github.com/zkpayroll/zk-payroll-sdk
- Default branch `dev`. HEAD `a3166417082436901aa2b66618fdaf9c6c08ae17` (1,050 files, tree `ad88572586352731fe1e4e08ae0e29077c552cb2`, the spec's §1 analysis).
- Snapshot baseline: the same `dev` HEAD, downloaded via codeload and committed as `b7bafa51c1262bbe4322391584e3212d26c37b9a` on 2026-11-12. Kept unmodified as the port's starting point. W2/W3 port from this committed baseline.
- License: MIT. `LICENSE` retains the origin copyright notice.

## Derived from the origin

- The TypeScript SDK snapshot at commit `b7bafa5` (`dev`) supplies module layout, public types, and behaviour. Later waves port that behaviour into `packages/core`.

## Not copied

- The origin references companion smart contracts whose license GitHub reports as `NOASSERTION`. Those files are not in the snapshot above and are not copied here.
- The Rust contract under `contract/` is a clean-room implementation written from the documented method surface. No contract source was copied. No companion contract code was used.

## License of this port

Port modifications in this repository are released under the MIT license, matching the origin.
