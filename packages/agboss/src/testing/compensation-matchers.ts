import type { ExecutionOutput } from "../app/types.js";
import type { Class } from "../components/injection.js";
import {
  CompensationStatus,
  type CompensationReason,
  type CompensationRecord,
} from "../flow/compensation.js";
import { nodeNameOf } from "./failure-facts.js";
import {
  isExecutionOutput,
  RUN,
  verdict,
  wrongReceived,
  type MatcherContext,
  type Verdict,
} from "./matchers.js";

/**
 * `toHaveCompensated(Action, { by, reason?, status? })` (#340): an undo action ran on a step of
 * `Action` — `by` the undo action, `reason` why (a side path, a failed join), `status` how it ended
 * (`Compensated` unless said otherwise) — read from `result.compensations`.
 */

/** How the step of the action is expected to have been undone. */
export interface ExpectedCompensation {
  /** The undo action that ran (`compensateWith`). */
  readonly by: Class;
  readonly reason?: CompensationReason;
  /** Default `CompensationStatus.Compensated`. */
  readonly status?: CompensationStatus;
}

function isExpected(
  record: CompensationRecord,
  action: string,
  expected: ExpectedCompensation,
): boolean {
  return (
    record.compensated.component.name === action &&
    record.compensator.name === nodeNameOf(expected.by) &&
    (expected.reason === undefined || record.reason === expected.reason) &&
    record.status === (expected.status ?? CompensationStatus.Compensated)
  );
}

const describeRecord = (record: CompensationRecord): string =>
  `${record.compensated.component.name} by ${record.compensator.name} (${record.reason}, ${record.status})`;

/** The compensation matcher, registered by the setup file next to the workflow matchers. */
export const compensationMatchers = {
  toHaveCompensated(
    this: MatcherContext,
    received: unknown,
    action: Class,
    expected: ExpectedCompensation,
  ): Verdict {
    if (!isExecutionOutput(received)) return wrongReceived("toHaveCompensated", RUN);
    const { compensations }: ExecutionOutput = received;
    const name = nodeNameOf(action);
    const pass = compensations.some((record) => isExpected(record, name, expected));
    const how = [
      expected.reason === undefined ? "" : `, ${expected.reason}`,
      `, ${expected.status ?? CompensationStatus.Compensated}`,
    ].join("");
    const ran = compensations.map(describeRecord).join("; ") || "none";
    const said = `${name} undone by ${nodeNameOf(expected.by)}${how}`;
    return verdict(this, pass, said, `the undo actions that ran: ${ran}`);
  },
};

/** The compensation matcher, typed for `expect(…)` in tests. */
export interface CompensationMatchers<R = unknown> {
  /** A step of `action` was undone by `by` (for `reason`, ending `status` — `Compensated` by default). */
  toHaveCompensated(action: Class, expected: ExpectedCompensation): R;
}
