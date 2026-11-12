/**
 * Typed client for the registry section of the subrosa contract.
 *
 * The contract derives the employer from `env::predecessor_account_id()` on
 * writes, so write arguments carry only the employee-side fields. Views take
 * the employer explicitly.
 */

import type { EmployeeEntry } from "../types.js";
import type { NearContractWrapper, NearContractCallOptions } from "./NearContractWrapper.js";
import {
  assertPageLimit,
  assertU32,
  normalizeCommitmentHash,
  parseAccountIdArray,
  parseBoolean,
  parseEmployeeEntry,
  requireAccountId,
  storageDepositNear,
} from "./entries.js";
import { ValidationError } from "../core/errors.js";

export interface RegisterEmployeeArgs {
  employee: string;
  salaryCommitment: string;
  token: string;
  metadata?: string;
}

export interface UpdateEmployeeArgs {
  employee: string;
  salaryCommitment: string;
}

export class RegistryClient {
  constructor(private readonly near: NearContractWrapper) {}

  /** Register an employee with a commitment hash (never the salary itself). */
  async registerEmployee(args: RegisterEmployeeArgs, opts?: NearContractCallOptions): Promise<void> {
    const metadata = args.metadata ?? "";
    const metadataBytes = new TextEncoder().encode(metadata).length;
    if (metadataBytes > 256) {
      throw new ValidationError("metadata must be at most 256 UTF-8 bytes.", "metadata");
    }
    await this.near.call<null>(
      "register_employee",
      {
        employee: requireAccountId(args.employee, "employee"),
        salary_commitment: normalizeCommitmentHash(args.salaryCommitment, "salaryCommitment"),
        token: requireAccountId(args.token, "token"),
        metadata,
      },
      { ...opts, deposit: opts?.deposit ?? storageDepositNear(267 + metadataBytes) },
    );
  }

  /** Replace an employee's commitment hash. */
  async updateEmployee(args: UpdateEmployeeArgs, opts?: NearContractCallOptions): Promise<void> {
    await this.near.call<null>(
      "update_employee",
      {
        employee: requireAccountId(args.employee, "employee"),
        salary_commitment: normalizeCommitmentHash(args.salaryCommitment, "salaryCommitment"),
      },
      opts,
    );
  }

  /** Soft-delete an employee record, keeping the audit trail. */
  async deactivateEmployee(employee: string, opts?: NearContractCallOptions): Promise<void> {
    await this.near.call<null>(
      "deactivate_employee",
      { employee: requireAccountId(employee, "employee") },
      opts,
    );
  }

  async getEmployee(employer: string, employee: string): Promise<EmployeeEntry | null> {
    const result = await this.near.view<EmployeeEntry | null>("get_employee", {
      employer: requireAccountId(employer, "employer"),
      employee: requireAccountId(employee, "employee"),
    });
    return parseEmployeeEntry(result);
  }

  async getEmployeeCount(employer: string): Promise<number> {
    const result = await this.near.view<number>("get_employee_count", {
      employer: requireAccountId(employer, "employer"),
    });
    return parseCount(result, "get_employee_count");
  }

  async getEmployees(employer: string, fromIndex: number, limit: number): Promise<string[]> {
    const result = await this.near.view<string[]>("get_employees", {
      employer: requireAccountId(employer, "employer"),
      from_index: assertU32(fromIndex, "fromIndex"),
      limit: assertPageLimit(limit),
    });
    return parseAccountIdArray(result, "get_employees");
  }

  async employeeExists(employer: string, employee: string): Promise<boolean> {
    const result = await this.near.view<boolean>("employee_exists", {
      employer: requireAccountId(employer, "employer"),
      employee: requireAccountId(employee, "employee"),
    });
    return parseBoolean(result, "employee_exists");
  }
}
