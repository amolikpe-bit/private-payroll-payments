/** Disclosure sensitivity levels, ordered `low < medium < high`. */
export type DisclosureLevel = "low" | "medium" | "high";

/** One field-level rule in a privacy policy. */
export interface PrivacyPolicyRule {
  field: string;
  allowed: boolean;
  sensitivity: DisclosureLevel;
}

/** Field rules plus the count of simultaneous high-sensitivity fields that triggers a warning. */
export interface PrivacyPolicy {
  rules: PrivacyPolicyRule[];
  combinationThreshold?: number;
}

/** Result of analysing a payload for disclosure risk. */
export interface DisclosureAnalysis {
  level: DisclosureLevel;
  blockedFields: string[];
  warnings: string[];
  riskFactors: string[];
  safe: boolean;
}

/** Running disclosure budget for one workflow. */
export interface PrivacyBudget {
  maxAllowedDisclosure: DisclosureLevel;
  fieldsUsed: Set<string>;
  combinationsExceeded: boolean;
}
