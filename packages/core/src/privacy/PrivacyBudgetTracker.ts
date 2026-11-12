import type { DisclosureLevel, PrivacyBudget } from "./types.js";

const HIGH_SENSITIVITY_FIELDS: Readonly<Record<string, true>> = {
  employee: true,
  recipient: true,
  amount: true,
  salary: true,
  salt: true,
  privateKey: true,
  depositAddress: true,
};

const MEDIUM_SENSITIVITY_FIELDS: Readonly<Record<string, true>> = {
  memo: true,
  period: true,
  department: true,
  jobTitle: true,
  manager: true,
  notes: true,
};

/**
 * Tracks which fields a workflow has touched and whether that exceeds the
 * configured disclosure budget.
 */
export class PrivacyBudgetTracker implements PrivacyBudget {
  maxAllowedDisclosure: DisclosureLevel;
  fieldsUsed: Set<string>;
  combinationsExceeded: boolean;

  constructor(maxAllowedDisclosure: DisclosureLevel = "medium") {
    this.maxAllowedDisclosure = maxAllowedDisclosure;
    this.fieldsUsed = new Set();
    this.combinationsExceeded = false;
  }

  /** Records one field access and re-checks the budget. */
  recordFieldAccess(fieldName: string): void {
    this.fieldsUsed.add(fieldName);
    this.checkBudget();
  }

  /** Records several field accesses at once and re-checks the budget. */
  recordMultipleFields(fieldNames: readonly string[]): void {
    for (const name of fieldNames) {
      this.fieldsUsed.add(name);
    }
    this.checkBudget();
  }

  /** True when no access has exceeded the configured budget. */
  isWithinBudget(): boolean {
    return !this.combinationsExceeded;
  }

  /** Fields touched so far that are still allowed at the configured level. */
  getFieldsWithinBudget(): string[] {
    if (this.isWithinBudget()) {
      return Array.from(this.fieldsUsed);
    }

    if (this.maxAllowedDisclosure === "low") {
      return Array.from(this.fieldsUsed).filter(
        (field) => HIGH_SENSITIVITY_FIELDS[field] !== true && MEDIUM_SENSITIVITY_FIELDS[field] !== true
      );
    }
    if (this.maxAllowedDisclosure === "medium") {
      return Array.from(this.fieldsUsed).filter(
        (field) => HIGH_SENSITIVITY_FIELDS[field] !== true
      );
    }

    return Array.from(this.fieldsUsed);
  }

  /** Sensitive fields that have not been touched yet. */
  getRemainingBudget(): string[] {
    const allFields = new Set([
      ...Object.keys(HIGH_SENSITIVITY_FIELDS),
      ...Object.keys(MEDIUM_SENSITIVITY_FIELDS),
    ]);
    return Array.from(allFields).filter((field) => !this.fieldsUsed.has(field));
  }

  /** Clears all recorded access. */
  reset(): void {
    this.fieldsUsed.clear();
    this.combinationsExceeded = false;
  }

  private checkBudget(): void {
    const hasHigh = Array.from(this.fieldsUsed).some(
      (field) => HIGH_SENSITIVITY_FIELDS[field] === true
    );
    if (this.maxAllowedDisclosure === "low") {
      const hasMedium = Array.from(this.fieldsUsed).some(
        (field) => MEDIUM_SENSITIVITY_FIELDS[field] === true
      );
      if (hasHigh || hasMedium) {
        this.combinationsExceeded = true;
      }
    } else if (this.maxAllowedDisclosure === "medium" && hasHigh) {
      this.combinationsExceeded = true;
    }
  }
}
