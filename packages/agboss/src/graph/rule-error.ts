import { ConfigError } from "../core/error-families/config-errors.js";
import type { RuleCode } from "./rule-codes.js";

export type { RuleCode } from "./rule-codes.js";

/** One broken rule: its code, what is wrong, and the nodes (classes) involved. */
export interface RuleViolation {
  readonly code: RuleCode;
  readonly message: string;
  readonly nodes: readonly string[];
}

export const violation = (
  code: RuleCode,
  message: string,
  nodes: readonly string[],
): RuleViolation => ({ code, message, nodes });

/** Throws when anything was found. */
export function throwIfViolated(violations: readonly RuleViolation[]): void {
  if (violations.length > 0) throw new ConfigError.GraphRules({ violations });
}
