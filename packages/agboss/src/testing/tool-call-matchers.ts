import type { ExecutionOutput } from "../app/types.js";
import type { ToolCallRecord } from "../flow/runtime/tool-calls.js";
import { ComponentKind } from "../flow/runtime/records.js";
import { ToolCallStatus } from "../flow/runtime/tool-calls.js";
import { matchesPartial } from "./input-match.js";
import {
  isExecutionOutput,
  RUN,
  verdict,
  wrongReceived,
  type MatcherContext,
  type Verdict,
} from "./matchers.js";
import { toolNameOf, type ToolClass } from "./script.js";
import type { DeepPartial } from "./script-types.js";

/**
 * The trajectory matchers on a run result (#395 S4): which tools the root execution's agents called
 * — whatever the order — and invariants of their arguments, read from `result.toolCalls` (a child's
 * calls are in `result.children`). They hold on a scripted run, a recorded one and a live one alike.
 */

/** What `toHaveToolCallMatching` looks for: a partial of the tool's input, or a check of it. */
export type ToolCallExpectation<TInput> = DeepPartial<TInput> | ((input: TInput) => boolean);

/** The calls of one tool by its name, whatever their status. */
const callsNamed = (run: ExecutionOutput, name: string): readonly ToolCallRecord[] =>
  run.toolCalls.filter(
    (call) => call.step.component.kind === ComponentKind.Tool && call.step.component.name === name,
  );

/** The statuses whose input passed the tool's input check: a check reads them typed. */
const CHECKED_INPUT: ReadonlySet<ToolCallStatus> = new Set([
  ToolCallStatus.Succeeded,
  ToolCallStatus.Failed,
  ToolCallStatus.TimedOut,
]);

const calledText = (run: ExecutionOutput): string => {
  const names = run.toolCalls.map((call) => `${call.step.component.name} (${call.status})`);
  return `it called ${names.join(", ") || "no tools"}`;
};

/** A check of the input, not a partial of it. */
const isCheck = <TInput>(
  expected: ToolCallExpectation<TInput>,
): expected is (input: TInput) => boolean => typeof expected === "function";

/** Whether one call matches the expectation: a check on a checked input, or a partial. */
function matches<TInput>(call: ToolCallRecord, expected: ToolCallExpectation<TInput>): boolean {
  if (!isCheck(expected)) return matchesPartial(call.input, expected);
  if (!CHECKED_INPUT.has(call.status)) return false;
  // the tool's input check passed on these arguments: they are its input
  return expected(call.input as TInput);
}

/** The trajectory matchers, registered by the setup file next to the workflow matchers. */
export const toolCallMatchers = {
  /**
   * Every one of these tools was called at least once, in any order; with `.not`, none of them was.
   */
  toHaveCalledTools(
    this: MatcherContext,
    received: unknown,
    tools: readonly ToolClass<object>[],
  ): Verdict {
    if (!isExecutionOutput(received)) return wrongReceived("toHaveCalledTools", RUN);
    const names = tools.map(toolNameOf);
    const called = names.filter((name) => callsNamed(received, name).length > 0);
    // `.not` asks that none was called: it fails as soon as one was
    const pass = this.isNot ? called.length > 0 : called.length === names.length;
    const listed = names.join(", ") || "no tools";
    // `.not` reads "expected not any of A, B to be called"
    const said = this.isNot ? `any of ${listed} to be called` : `a call of each of ${listed}`;
    return verdict(this, pass, said, calledText(received));
  },

  /** Some call of the tool matches the partial (or the check); with `.not`, none does. */
  toHaveToolCallMatching<TInput extends object>(
    this: MatcherContext,
    received: unknown,
    tool: ToolClass<TInput>,
    expected: ToolCallExpectation<TInput>,
  ): Verdict {
    if (!isExecutionOutput(received)) return wrongReceived("toHaveToolCallMatching", RUN);
    const name = toolNameOf(tool);
    const calls = callsNamed(received, name);
    const pass = calls.some((call) => matches(call, expected));
    const what = isCheck(expected) ? "the check" : JSON.stringify(expected);
    const inputs = calls.map((call) => JSON.stringify(call.input)).join(", ") || "none";
    return verdict(this, pass, `a call of ${name} matching ${what}`, `its calls: ${inputs}`);
  },
};

/** The trajectory matchers, typed for `expect(…)` in tests. */
export interface ToolCallMatchers<R = unknown> {
  /** Each of these tools was called at least once, in any order (`.not`: none of them was). */
  toHaveCalledTools(tools: readonly ToolClass<object>[]): R;
  /** Some call of `tool` has an input matching the partial or the check (`.not`: none does). */
  toHaveToolCallMatching<TInput extends object>(
    tool: ToolClass<TInput>,
    expected: ToolCallExpectation<TInput>,
  ): R;
}
