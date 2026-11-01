import { LimitExceededError } from "../graph/limits.js";
import type { UsageRecord } from "../finops/usage.js";
import type { Milliseconds } from "../units/index.js";

/**
 * An execution's deadline (#398 PR 2): `app.execute(…, { deadline: seconds(30) })`, or the time a
 * trusted mesh caller still waits (its envelope's `deadline.remaining`), the smaller of the two —
 * fixed on the application's `Clock` at the execution's start and kept in its state, so a pause
 * counts as time and a resume after the deadline fails. Checked where the budgets are: before every
 * step that can spend (#634) and before every model call.
 */
export interface ExecutionDeadline {
  /** When it passes (ISO 8601, the `Clock`). */
  readonly at: string;
  /** The duration it was set to. */
  readonly deadline: Milliseconds;
}

/** An execution ran past its deadline: it fails before its next step or model call. */
export class DeadlineExceededError extends LimitExceededError {
  static override readonly code: string = "limit.deadline";
  override name = "DeadlineExceededError";
  /** The duration it was given. */
  readonly deadline: Milliseconds;
  /** When it passed (ISO 8601). */
  readonly deadlineAt: string;

  constructor(
    deadline: ExecutionDeadline,
    path: readonly string[],
    spentUsd: number,
    usage: readonly UsageRecord[] = [],
  ) {
    const seconds = deadline.deadline / 1000;
    super(
      { key: "deadline", limit: deadline.deadline, actual: deadline.deadline },
      path,
      spentUsd,
      usage,
      {
        message: `the execution ran past its deadline of ${String(seconds)} s (at ${deadline.at})`,
        details: { deadline: deadline.deadline, deadlineAt: deadline.at },
      },
    );
    this.deadline = deadline.deadline;
    this.deadlineAt = deadline.at;
  }
}

/** The deadline of a new execution started now, of `delay`; `undefined` without one. */
export function deadlineFrom(now: Date, delay: number | undefined): ExecutionDeadline | undefined {
  if (delay === undefined || !Number.isFinite(delay)) return undefined;
  const deadline = Math.max(0, Math.round(delay)) as Milliseconds;
  return { at: new Date(now.getTime() + deadline).toISOString(), deadline };
}

/** Throws `DeadlineExceededError` once `now` reached the deadline. */
export function checkDeadline(
  deadline: ExecutionDeadline | undefined,
  now: Date,
  place: {
    readonly path: readonly string[];
    readonly spentUsd: number;
    readonly usage: readonly UsageRecord[];
  },
): void {
  if (deadline === undefined || now.getTime() < Date.parse(deadline.at)) return;
  throw new DeadlineExceededError(deadline, place.path, place.spentUsd, place.usage);
}

/** The smaller of two optional delays. */
export const earliestOf = (
  first: number | undefined,
  second: number | undefined,
): number | undefined =>
  first === undefined ? second : second === undefined ? first : Math.min(first, second);

/** An execution's context values with its deadline (none → as they are). */
export const withExecutionDeadline = <TValues extends object>(
  values: TValues,
  deadline: ExecutionDeadline | undefined,
): TValues => (deadline === undefined ? values : { ...values, deadline });
