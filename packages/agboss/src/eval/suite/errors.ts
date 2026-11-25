/** One value of a case that does not fit (#396): the case, where in it and why — never the value. */
export interface EvalCaseIssue {
  /** The case's `name`. */
  readonly case: string;
  /** Where in the case: `tenant.plan`, `turns[0].text`, `history[2].output.text`. */
  readonly path: string;
  readonly reason: string;
}
