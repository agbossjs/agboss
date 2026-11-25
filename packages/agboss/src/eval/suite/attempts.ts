/**
 * The hooks around one run of a case (#1328d, `@agboss/core/eval`): `beforeAttempt` resets what the
 * run's stubs and databases hold, `afterAttempt` cleans up — before and after each of the `runs`
 * repetitions a pass^k reads, so the second run does not start on what the first left. A hook's
 * failure fails that run (never the suite), whatever else it did.
 */

/** Which run a hook is told about. */
export interface EvalAttempt {
  /** The case's name. */
  readonly case: string;
  /** The repetition, from 1 to `runs`. */
  readonly run: number;
}

/** A hook around one run of a case: the suite's first before, last after. */
export type EvalAttemptHook = (attempt: EvalAttempt) => void | Promise<void>;
