import { DEFAULT_TENANT_ID } from "../flow/context/tenant-context.js";
import { sortedJson } from "../flow/runtime/json.js";
import { ToolCallStatus, type ToolCallRecord } from "../flow/runtime/tool-calls.js";
import {
  ExecutionHistoryStatus,
  type ExecutionHistoryRecord,
} from "../infrastructure/execution-history.repository.js";

/**
 * An eval case drafted from what an execution did (#396 PR 8): its start's input as the case's turn,
 * its contexts, the thread's earlier finished turns as its history, and the tool calls it ran as the
 * case's required calls — plain data by component name, for a generator to write as an
 * `evalCase({ … })` (`agboss generate eval-case --from-execution`) or a page to save as one (#397
 * PR 5: "save as golden case"). Values are taken as observed: from the execution history they are
 * masked, as it keeps them.
 */

/** One finished turn of a thread: where it started and with what, where it finished and with what. */
export interface ObservedTurn {
  readonly start: string;
  readonly input: unknown;
  readonly finish: string;
  readonly output: unknown;
}

/** What an execution did, as a case reads it — from a kept record, or from a run's trace. */
export interface ObservedExecution {
  /** Its start's name and input: the case's one turn. */
  readonly start: string;
  readonly input: unknown;
  /** Its tenant's and execution's context values. */
  readonly tenant: Readonly<Record<string, unknown>>;
  readonly execution: Readonly<Record<string, unknown>>;
  /** The thread's turns before it, oldest first. */
  readonly history: readonly ObservedTurn[];
  /** The tool calls of its own agents, in call order. */
  readonly toolCalls: readonly ToolCallRecord[];
}

/** A call the case requires: the tool by name and the arguments it was called with. */
export interface DraftToolCall {
  readonly tool: string;
  readonly arguments: unknown;
}

/** The case, by component names: what `evalCase({ … })` will say. */
export interface EvalCaseDraft {
  readonly name: string;
  /** The start the case's turn goes through (the suite's `start`). */
  readonly start: string;
  /** Its tenant values; none for the default tenant without fields. */
  readonly tenant?: Readonly<Record<string, unknown>>;
  /** Its execution values; none when it had none. */
  readonly execution?: Readonly<Record<string, unknown>>;
  readonly history: readonly ObservedTurn[];
  readonly turns: readonly { readonly input: unknown }[];
  readonly required: readonly DraftToolCall[];
}

/** Calls a tool ran (not refused before it): what a case can require again. */
const RAN: ReadonlySet<ToolCallStatus> = new Set([
  ToolCallStatus.Succeeded,
  ToolCallStatus.Failed,
  ToolCallStatus.TimedOut,
]);

/** The calls it ran, each tool with the same arguments once, in call order. */
function requiredCallsOf(calls: readonly ToolCallRecord[]): readonly DraftToolCall[] {
  const seen = new Set<string>();
  return calls.flatMap((call) => {
    if (!RAN.has(call.status)) return [];
    const tool = call.step.component.name;
    const key = `${tool}\u0000${sortedJson(call.input)}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ tool, arguments: call.input }];
  });
}

/** The tenant values worth stating: any but the default tenant's bare id. */
function tenantOf(tenant: Readonly<Record<string, unknown>>) {
  const fields = Object.keys(tenant).filter((key) => key !== "tenantId");
  const isDefault = (tenant.tenantId ?? DEFAULT_TENANT_ID) === DEFAULT_TENANT_ID;
  return isDefault && fields.length === 0 ? {} : { tenant };
}

/** The case `name` would be, drafted from `observed`. */
export function evalCaseDraftOf(name: string, observed: ObservedExecution): EvalCaseDraft {
  return {
    name,
    start: observed.start,
    ...tenantOf(observed.tenant),
    ...(Object.keys(observed.execution).length === 0 ? {} : { execution: observed.execution }),
    history: observed.history,
    turns: [{ input: observed.input }],
    required: requiredCallsOf(observed.toolCalls),
  };
}

/** A kept turn as a past turn of its thread: only one that finished. */
const turnOf = (record: ExecutionHistoryRecord): readonly ObservedTurn[] =>
  record.status === ExecutionHistoryStatus.Finished && record.finish !== undefined
    ? [
        {
          start: record.start.name,
          input: record.input,
          finish: record.finish.name,
          output: record.output,
        },
      ]
    : [];

/**
 * What a kept execution did: its own record, and its thread's records (any order) for the turns
 * that finished before it started.
 */
export function observedExecutionOf(
  record: ExecutionHistoryRecord,
  thread: readonly ExecutionHistoryRecord[],
): ObservedExecution {
  const earlier = thread
    .filter((turn) => turn.executionId !== record.executionId && turn.startedAt < record.startedAt)
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  return {
    start: record.start.name,
    input: record.input,
    tenant: record.contexts.tenant,
    execution: record.contexts.execution,
    history: earlier.flatMap(turnOf),
    toolCalls: record.toolCalls,
  };
}
