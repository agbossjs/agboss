import { AGBossError } from "../core/errors.js";
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

/** What a rule error takes (#906): every violation found. */
export interface GraphRuleErrorOptions {
  readonly violations: readonly RuleViolation[];
  readonly cause?: unknown;
}

/** The flow breaks assembly rules — every violation found, reported at once, before any model call. */
export class GraphRuleError extends AGBossError {
  static override readonly code = "graph.rules" as const;
  declare readonly code: typeof GraphRuleError.code;
  override name = "GraphRuleError";
  readonly violations: readonly RuleViolation[];

  constructor(options: GraphRuleErrorOptions) {
    const { violations, cause } = options;
    const lines = violations.map((item) => `  - [${item.code}] ${item.message}`);
    super(`The workflow's flow breaks ${String(violations.length)} rule(s):\n${lines.join("\n")}`, {
      cause,
    });
    this.violations = violations;
  }
}

/** Throws when anything was found. */
export function throwIfViolated(violations: readonly RuleViolation[]): void {
  if (violations.length > 0) throw new GraphRuleError({ violations });
}
