import type { EvalRunResult } from "agboss/eval";

/**
 * What one attempt (one of a case's k runs) came to, as the report's dots show it (#397 PR 1):
 * passed, failed (it ran and a check failed or was skipped), error (a turn failed or paused before
 * the checks), limit (that error was a `limit.*` — a budget, the steps, a node's visits).
 */
export enum AttemptStatus {
  Passed = "passed",
  Failed = "failed",
  Error = "error",
  Limit = "limit",
}

/** The error codes of every limit (`LimitExceededError`) start with it. */
const LIMIT_CODE = /^limit(\.|$)/u;

export function attemptStatusOf(result: EvalRunResult): AttemptStatus {
  if (result.passed) return AttemptStatus.Passed;
  if (result.error === undefined) return AttemptStatus.Failed;
  return LIMIT_CODE.test(result.error.code) ? AttemptStatus.Limit : AttemptStatus.Error;
}

/** The dot's symbol: readable without colour. */
export const ATTEMPT_SYMBOLS: Readonly<Record<AttemptStatus, string>> = {
  [AttemptStatus.Passed]: "✓",
  [AttemptStatus.Failed]: "✗",
  [AttemptStatus.Error]: "!",
  [AttemptStatus.Limit]: "⌀",
};
