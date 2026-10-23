import { nameOf } from "../../components/name-of.js";
import type { ToolHandlerClass } from "../../components/decorators.js";
import { toolCallsOf, ToolCallStatus, type ToolCallRecord } from "../../flow/runtime/tool-calls.js";
import { matchesPartial } from "../../testing/input-match.js";
import type {
  EvalToolExpectations,
  ExpectedToolCall,
  ToolInvariant,
} from "../suite/tool-expectations.js";

/**
 * `checkTrajectory()` at run time (#396 PR 2): a case's `tools` against the tool calls of its last
 * turn (`result.toolCalls`) — deterministic, no model, $0. A required tool needs a call the tool
 * ran (succeeded, failed or timed out) with the partial's arguments; a forbidden tool any call at
 * all, even one that never ran; an invariant holds on every call with checked arguments.
 */

/** Calls the tool ran: neither refused before it (invalid, declined, blocked) nor answered for it. */
const RAN: ReadonlySet<ToolCallStatus> = new Set([
  ToolCallStatus.Succeeded,
  ToolCallStatus.Failed,
  ToolCallStatus.TimedOut,
]);

/** Calls whose arguments no input check passed: the model's own, never the tool's input. */
const UNCHECKED: ReadonlySet<ToolCallStatus> = new Set([
  ToolCallStatus.InvalidArguments,
  ToolCallStatus.UnknownTool,
]);

const callsOf = (tool: ToolHandlerClass, calls: readonly ToolCallRecord[]) =>
  toolCallsOf(tool, calls) as readonly ToolCallRecord[];

function missingRequired(expected: ExpectedToolCall, calls: readonly ToolCallRecord[]): string[] {
  const ran = callsOf(expected.tool, calls).filter((call) => RAN.has(call.status));
  const { arguments: partial } = expected;
  const isMatched = ran.some(
    (call) => partial === undefined || matchesPartial(call.input, partial),
  );
  if (isMatched) return [];
  const name = nameOf(expected.tool);
  if (partial === undefined) return [`${name} not called (required)`];
  return [
    `${name} not called with ${JSON.stringify(partial)} (required; ${String(ran.length)} call(s))`,
  ];
}

function calledForbidden(tool: ToolHandlerClass, calls: readonly ToolCallRecord[]): string[] {
  const found = callsOf(tool, calls).length;
  return found === 0 ? [] : [`${nameOf(tool)} called (forbidden)`];
}

function brokenInvariant(invariant: ToolInvariant, calls: readonly ToolCallRecord[]): string[] {
  const checked = callsOf(invariant.tool, calls).filter((call) => !UNCHECKED.has(call.status));
  const broken = checked.filter((call) => !invariant.holds(call.input)).length;
  return broken === 0
    ? []
    : [`${nameOf(invariant.tool)}: ${String(broken)} call(s) break an invariant`];
}

/** Why the trajectory fails its expectations, one reason per broken expectation; none = it passes. */
export function trajectoryFailures(
  expectations: EvalToolExpectations | undefined,
  calls: readonly ToolCallRecord[],
): readonly string[] {
  if (expectations === undefined) return [];
  return [
    ...(expectations.required ?? []).flatMap((expected) => missingRequired(expected, calls)),
    ...(expectations.forbidden ?? []).flatMap((tool) => calledForbidden(tool, calls)),
    ...(expectations.invariants ?? []).flatMap((invariant) => brokenInvariant(invariant, calls)),
  ];
}

/** The tools a turn ran, each once, by name, sorted — what `--metamorphic` compares (#396 PR 7). */
export function ranToolNames(calls: readonly ToolCallRecord[]): readonly string[] {
  const names = calls
    .filter((call) => RAN.has(call.status))
    .map((call) => call.step.component.name);
  return [...new Set(names)].sort();
}
