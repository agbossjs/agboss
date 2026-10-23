import { AGBossError } from "../../core/errors.js";

/** One value of a case that does not fit (#396): the case, where in it and why — never the value. */
export interface EvalCaseIssue {
  /** The case's `name`. */
  readonly case: string;
  /** Where in the case: `tenant.plan`, `turns[0].text`, `history[2].output.text`. */
  readonly path: string;
  readonly reason: string;
}

/**
 * Cases of an eval suite whose values do not fit (`eval.case-invalid`, #396): their tenant or
 * execution values (validated like `app.execute`'s), a turn's input (the suite's start), a past
 * turn's start input or finish output — every issue at once, before anything runs.
 */
export class EvalCaseInvalidError extends AGBossError {
  static override readonly code: string = "eval.case-invalid";
  override name = "EvalCaseInvalidError";

  constructor(
    /** The suite's `name`. */
    readonly suite: string,
    readonly issues: readonly EvalCaseIssue[],
  ) {
    const lines = issues.map(
      (issue) => `  - case "${issue.case}": ${issue.path} — ${issue.reason}`,
    );
    super(
      `${suite}: ${String(issues.length)} invalid value(s) in its cases:\n${lines.join("\n")}`,
      {
        details: { suite, issues: issues.map((issue) => ({ ...issue })) },
      },
    );
  }
}
