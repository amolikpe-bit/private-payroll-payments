/**
 * Disclosure-risk analysis for payloads that leave the private payroll store
 * (exports, statements, audit bundles).
 *
 * The analyzer classifies each known field by sensitivity, flags blocked
 * fields, and warns on combinations that re-identify an employee even when
 * each field individually looks harmless.
 */

import type { DisclosureAnalysis, DisclosureLevel, PrivacyPolicy } from "./types.js";

const DEFAULT_SENSITIVE_FIELDS: Readonly<Record<string, DisclosureLevel>> = {
  employee: "high",
  recipient: "high",
  amount: "high",
  salary: "high",
  salt: "high",
  privateKey: "high",
  depositAddress: "high",
  commitment_hash: "low",
  asset: "low",
  memo: "medium",
  period: "medium",
  cycle_id: "low",
  department: "medium",
  jobTitle: "medium",
  manager: "medium",
  notes: "medium",
  timestamp: "low",
  at_ns: "low",
  txHash: "low",
};

const RISKY_COMBINATIONS: readonly (readonly [string, string])[] = [
  ["employee", "amount"],
  ["recipient", "amount"],
  ["employee", "memo"],
  ["employee", "department"],
];

const LEVEL_ORDER: readonly DisclosureLevel[] = ["low", "medium", "high"];

/** Analyzes payloads against a field-level privacy policy. */
export class DisclosureAnalyzer {
  private readonly policy: PrivacyPolicy;

  constructor(customPolicy?: PrivacyPolicy) {
    this.policy =
      customPolicy ??
      ({
        rules: Object.entries(DEFAULT_SENSITIVE_FIELDS).map(([field, sensitivity]) => ({
          field,
          allowed: true,
          sensitivity,
        })),
        combinationThreshold: 3,
      } satisfies PrivacyPolicy);
  }

  /** Classifies a payload's disclosure level and lists risk factors. */
  analyze(payload: Record<string, unknown>): DisclosureAnalysis {
    const blockedFields: string[] = [];
    const warnings: string[] = [];
    const riskFactors: string[] = [];
    const fieldsPresent = Object.keys(payload);
    let maxLevel: DisclosureLevel = "low";

    for (const field of fieldsPresent) {
      const rule = this.policy.rules.find((candidate) => candidate.field === field);
      if (!rule) continue;
      if (!rule.allowed) {
        blockedFields.push(field);
      }
      if (LEVEL_ORDER.indexOf(rule.sensitivity) > LEVEL_ORDER.indexOf(maxLevel)) {
        maxLevel = rule.sensitivity;
      }
    }

    const highSensitivityCount = fieldsPresent.filter(
      (field) => DEFAULT_SENSITIVE_FIELDS[field] === "high"
    ).length;

    for (const [first, second] of RISKY_COMBINATIONS) {
      if (fieldsPresent.includes(first) && fieldsPresent.includes(second)) {
        riskFactors.push(
          `Combination of ${first} and ${second} increases disclosure risk`
        );
      }
    }

    if (highSensitivityCount >= (this.policy.combinationThreshold ?? 3)) {
      warnings.push(
        `Multiple sensitive fields present (${highSensitivityCount}). Consider redacting some values.`
      );
      if (maxLevel === "low") {
        maxLevel = "medium";
      }
    }

    return {
      level: maxLevel,
      blockedFields,
      warnings,
      riskFactors,
      safe: blockedFields.length === 0 && riskFactors.length === 0,
    };
  }

  /** Validates that a payload may be exported at or below `maxAllowedLevel`. */
  validateExport(
    payload: Record<string, unknown>,
    maxAllowedLevel: DisclosureLevel
  ): { valid: boolean; reasons: string[] } {
    const analysis = this.analyze(payload);
    const reasons: string[] = [];

    if (analysis.blockedFields.length > 0) {
      reasons.push(`Forbidden fields present: ${analysis.blockedFields.join(", ")}`);
    }

    if (LEVEL_ORDER.indexOf(analysis.level) > LEVEL_ORDER.indexOf(maxAllowedLevel)) {
      reasons.push(
        `Disclosure level ${analysis.level} exceeds maximum allowed ${maxAllowedLevel}`
      );
    }

    return { valid: reasons.length === 0, reasons };
  }
}
