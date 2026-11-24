import { GraphRuleError, type RuleViolation } from "../graph/rule-error.js";
import { distinctViolations } from "../graph/distinct-violations.js";

/** The rules an application breaks, its workflows' included: a `GraphRuleError` naming the application. */
class ApplicationRuleError extends GraphRuleError {
  constructor(violations: readonly RuleViolation[]) {
    super({ violations });
    const lines = violations.map((item) => `  - [${item.code}] ${item.message}`);
    this.message = `The application breaks ${String(violations.length)} rule(s):\n${lines.join("\n")}`;
  }
}

/** One error for everything found: a single workflow's own error as it is, else all violations. */
export function throwIfAny(own: readonly RuleViolation[], errors: readonly GraphRuleError[]): void {
  const [only] = errors;
  if (own.length === 0 && errors.length === 1 && only !== undefined) throw only;
  const all = distinctViolations([...own, ...errors.flatMap((error) => error.violations)]);
  if (all.length > 0) throw new ApplicationRuleError(all);
}
