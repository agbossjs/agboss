import type { ExecutionOutput } from "../app/types.js";
import type { Class } from "../components/injection.js";
import { codeOfErrorClass, recordMatches } from "../core/error-record.js";
import type { ErrorClass } from "../flow/ast.js";
import {
  ChildExecutionStatus,
  type ChildExecutionRecord,
  type HandledErrorRecord,
} from "../flow/runtime/child-records.js";
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
 * Matchers on child executions (#263, on #262's matchers): `toHaveChildExecutions(W, [...])` — the
 * executions of `W` in the result's tree, in item order (then the order they ended), each as
 * expected — and `toHaveHandledError(E, { at, by })` — an error of class `E` (or caused by one)
 * happened at `at` and was taken by the side path starting at `by`.
 */

/** One expected child execution: its item (its start's input, or a field of it) and how it ended. */
export interface ExpectedChildExecution {
  /** The child's start input — or, for a map input, one of its fields. */
  readonly item?: unknown;
  /** It ended at this finish. */
  readonly finish?: Class;
  /** It failed with an error of this class (or one caused by it). */
  readonly failedWith?: ErrorClass;
  /** A sibling's failure or a cancel stopped it. */
  readonly cancelled?: boolean;
}

/** Where `toHaveHandledError` expects the error: the failing node, the side path's first node. */
export interface ExpectedHandling {
  /** The node that failed: a step, or the launched node of a failed join's branch. */
  readonly at?: Class;
  /** The first node of the side path that took it. */
  readonly by?: Class;
}

/** Every child execution of the result's tree, depth first. */
function treeOf(children: readonly ChildExecutionRecord[]): readonly ChildExecutionRecord[] {
  return children.flatMap((child) => [child, ...treeOf(child.children)]);
}

const byItem = (first: ChildExecutionRecord, second: ChildExecutionRecord): number =>
  (first.itemIndex ?? 0) - (second.itemIndex ?? 0);

function isItem(context: MatcherContext, record: ChildExecutionRecord, item: unknown): boolean {
  if (context.equals(record.input, item)) return true;
  const { input } = record;
  return (
    typeof input === "object" &&
    input !== null &&
    Object.values(input).some((field) => context.equals(field, item))
  );
}

function endsAsExpected(record: ChildExecutionRecord, expected: ExpectedChildExecution): boolean {
  const { finish, failedWith, cancelled } = expected;
  if (finish !== undefined)
    return (
      record.status === ChildExecutionStatus.Finished && record.finish?.name === nodeNameOf(finish)
    );
  if (failedWith !== undefined)
    return (
      record.status === ChildExecutionStatus.Failed &&
      record.error !== undefined &&
      recordMatches(record.error, codeOfErrorClass(failedWith))
    );
  return cancelled !== true || record.status === ChildExecutionStatus.Cancelled;
}

const describeChild = (record: ChildExecutionRecord): string =>
  `${JSON.stringify(record.input)} ${record.status}` +
  (record.finish === undefined ? "" : ` at ${record.finish.name}`) +
  (record.error === undefined ? "" : ` with ${record.error.code}`);

const describeExpected = (expected: ExpectedChildExecution): string =>
  [
    expected.item === undefined ? "" : JSON.stringify(expected.item),
    expected.finish === undefined ? "" : `finished at ${nodeNameOf(expected.finish)}`,
    expected.failedWith === undefined ? "" : `failed with ${expected.failedWith.name}`,
    expected.cancelled === true ? "cancelled" : "",
  ]
    .filter((part) => part !== "")
    .join(" ");

function handledAsExpected(
  record: HandledErrorRecord,
  error: ErrorClass,
  handling: ExpectedHandling,
): boolean {
  const { at, by } = handling;
  return (
    recordMatches(record.error, codeOfErrorClass(error)) &&
    (at === undefined || record.at.name === nodeNameOf(at)) &&
    (by === undefined || record.by.name === nodeNameOf(by))
  );
}

const describeHandled = (record: HandledErrorRecord): string =>
  `${record.error.name} at ${record.at.name} by ${record.by.name}`;

/** The child matchers, registered by the setup file next to the workflow matchers. */
export const childMatchers = {
  toHaveChildExecutions(
    this: MatcherContext,
    received: unknown,
    workflow: Class,
    expected: readonly ExpectedChildExecution[],
  ): Verdict {
    if (!isExecutionOutput(received)) return wrongReceived("toHaveChildExecutions", RUN);
    const name = nodeNameOf(workflow);
    const ran = treeOf(received.children).filter((child) => child.workflow.name === name);
    const sorted = [...ran].sort(byItem);
    const pass =
      sorted.length === expected.length &&
      expected.every((wanted, index) => {
        const record = sorted[index];
        if (record === undefined) return false;
        return (
          (wanted.item === undefined || isItem(this, record, wanted.item)) &&
          endsAsExpected(record, wanted)
        );
      });
    const said = `${name} to run as [${expected.map(describeExpected).join("; ")}]`;
    return verdict(this, pass, said, `it ran as [${sorted.map(describeChild).join("; ")}]`);
  },

  toHaveHandledError(
    this: MatcherContext,
    received: unknown,
    error: ErrorClass,
    handling: ExpectedHandling = {},
  ): Verdict {
    if (!isExecutionOutput(received)) return wrongReceived("toHaveHandledError", RUN);
    const { handledErrors }: ExecutionOutput = received;
    const pass = handledErrors.some((record) => handledAsExpected(record, error, handling));
    const where = [
      handling.at === undefined ? "" : ` at ${nodeNameOf(handling.at)}`,
      handling.by === undefined ? "" : ` by ${nodeNameOf(handling.by)}`,
    ].join("");
    const handled = handledErrors.map(describeHandled).join(", ") || "none";
    return verdict(this, pass, `a handled ${error.name}${where}`, `it handled: ${handled}`);
  },
};

/** The child matchers, typed for `expect(…)` in tests. */
export interface ChildMatchers<R = unknown> {
  /** The executions of `workflow` in the result's tree, in item order, each as expected. */
  toHaveChildExecutions(workflow: Class, expected: readonly ExpectedChildExecution[]): R;
  /** An error of the class (or caused by one) happened at `at` and `by`'s side path took it. */
  toHaveHandledError(error: ErrorClass, handling?: ExpectedHandling): R;
}
