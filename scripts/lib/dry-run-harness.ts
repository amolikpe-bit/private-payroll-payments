/** Shared constants and secret scanning for the two zero-funds dry runs. */

export const EMPLOYER = "subrosa.testnet";
export const EMPLOYEES = ["alice-demo.testnet", "bob-demo.testnet", "carol-demo.testnet"] as const;
export const AMOUNTS = [1_250_000n, 2_400_000n, 3_100_000n] as const;
export const CYCLE_ID = 1;
export const DEMO_TIMEOUT_MS = 30_000;

export interface SecretScanner {
  readonly secrets: Set<string>;
  assertNoSecrets(text: string): void;
}

/** Build the per-run secret set with a caller-owned fail-closed error. */
export function createSecretScanner(onLeak: () => never): SecretScanner {
  const secrets = new Set<string>();
  return {
    secrets,
    assertNoSecrets(text: string): void {
      for (const secret of secrets) {
        if (secret.length > 0 && text.includes(secret)) {
          onLeak();
        }
      }
    },
  };
}
