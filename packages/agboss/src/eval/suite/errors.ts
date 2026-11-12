import { AGBossError } from "../../core/errors.js";

/** One value of a case that does not fit (#396): the case, where in it and why — never the value. */
export interface EvalCaseIssue {
  /** The case's `name`. */
  readonly case: string;
  /** Where in the case: `tenant.plan`, `turns[0].text`, `history[2].output.text`. */
  readonly path: string;
  readonly reason: string;
}

/** What invalid cases take (#906): the suite and every issue. */
export interface EvalCaseInvalidErrorOptions {
  /** The suite's `name`. */
  readonly suite: string;
  readonly issues: readonly EvalCaseIssue[];
  readonly cause?: unknown;
}

/**
 * Cases of an eval suite whose values do not fit (`eval.case-invalid`, #396): their tenant or
 * execution values (validated like `app.execute`'s), a turn's input (the suite's start), a past
 * turn's start input or finish output — every issue at once, before anything runs.
 */
export class EvalCaseInvalidError extends AGBossError {
  static override readonly code = "eval.case-invalid" as const;
  declare readonly code: typeof EvalCaseInvalidError.code;
  override name = "EvalCaseInvalidError";

  /** The suite's `name`. */
  readonly suite: string;
  /** Every invalid value, by case and path. */
  readonly issues: readonly EvalCaseIssue[];

  constructor(options: EvalCaseInvalidErrorOptions) {
    const { suite, issues, cause } = options;
    const lines = issues.map(
      (issue) => `  - case "${issue.case}": ${issue.path} — ${issue.reason}`,
    );
    super(
      `${suite}: ${String(issues.length)} invalid value(s) in its cases:\n${lines.join("\n")}`,
      {
        cause,
        details: { suite, issues: issues.map((issue) => ({ ...issue })) },
      },
    );
    this.suite = suite;
    this.issues = issues;
  }
}
