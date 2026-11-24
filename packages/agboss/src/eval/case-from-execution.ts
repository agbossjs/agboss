import { ExecutionStatus } from "../app/types.js";
import { DEFAULT_TENANT_ID } from "../flow/context/tenant-context.js";
import { sortedJson } from "../flow/runtime/json.js";
import { PauseResolution } from "../infrastructure/pause-record.js";
import type { PauseAnswerRecord } from "../flow/runtime/execution-record.js";
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
 * masked, as it keeps them. The pauses a person answered become the turn's scripted answers
 * (`answerPause`), and a run that was stopped or cancelled the case's `expectedStatus`.
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
  /** The pauses of its tree that were resolved, in the order they were asked. */
  readonly pauses: readonly PauseAnswerRecord[];
  /** How it ended. */
  readonly status: ExecutionHistoryStatus;
}

/** A call the case requires: the tool by name and the input it was called with. */
export interface DraftToolCall {
  readonly tool: string;
  readonly input: unknown;
}

/** A pause a person answered: the target by name (its role's or channel's) and what was decided. */
export interface DraftPause {
  readonly target: string;
  readonly decision: unknown;
  /** Who answered, when the record kept it: a placeholder id (`actor-1`), never the real one. */
  readonly actor?: { readonly id: string };
}

/** One turn of the drafted case: the start's input and the pauses it met. */
export interface DraftTurn {
  readonly input: unknown;
  readonly pauses?: readonly DraftPause[];
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
  readonly turns: readonly DraftTurn[];
  readonly required: readonly DraftToolCall[];
  /** How the run must end when it did not finish: `Stopped` or `Cancelled`; none for the default. */
  readonly expectedStatus?: ExecutionStatus.Stopped | ExecutionStatus.Cancelled;
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
    return [{ tool, input: call.input }];
  });
}

/**
 * The pauses a person answered: replied, with a decision kept; the target is the channel asked.
 * The decision is the record's, masked like its inputs and outputs (the history masks the pauses
 * by their execution's chain). The person who answered is not masked data but an identity — an
 * owner id or a credential: a drafted case, saved as a golden file, names a placeholder instead
 * (`actor-1`, `actor-2` …, one per person, stable within the case).
 */
function pausesOf(pauses: readonly PauseAnswerRecord[]): readonly DraftPause[] {
  const placeholders = new Map<string, string>();
  const placeholderOf = (person: string): string => {
    const known = placeholders.get(person);
    if (known !== undefined) return known;
    const made = `actor-${String(placeholders.size + 1)}`;
    placeholders.set(person, made);
    return made;
  };
  return pauses.flatMap((pause) =>
    pause.resolution === PauseResolution.Replied && pause.decision !== undefined
      ? [
          {
            target: pause.role,
            decision: pause.decision,
            ...(pause.answeredBy === undefined
              ? {}
              : { actor: { id: placeholderOf(pause.answeredBy) } }),
          },
        ]
      : [],
  );
}

/** What a record that did not finish expects of its replay: a stop or a cancel; none otherwise. */
function expectedStatusOf(status: ExecutionHistoryStatus): EvalCaseDraft["expectedStatus"] {
  if (status === ExecutionHistoryStatus.Stopped) return ExecutionStatus.Stopped;
  return status === ExecutionHistoryStatus.Cancelled ? ExecutionStatus.Cancelled : undefined;
}

/** The tenant values worth stating: any but the default tenant's bare id. */
function tenantOf(tenant: Readonly<Record<string, unknown>>) {
  const fields = Object.keys(tenant).filter((key) => key !== "tenantId");
  const isDefault = (tenant.tenantId ?? DEFAULT_TENANT_ID) === DEFAULT_TENANT_ID;
  return isDefault && fields.length === 0 ? {} : { tenant };
}

/** The case `name` would be, drafted from `observed`. */
export function evalCaseDraftOf(name: string, observed: ObservedExecution): EvalCaseDraft {
  const pauses = pausesOf(observed.pauses);
  const expectedStatus = expectedStatusOf(observed.status);
  return {
    name,
    start: observed.start,
    ...tenantOf(observed.tenant),
    ...(Object.keys(observed.execution).length === 0 ? {} : { execution: observed.execution }),
    history: observed.history,
    turns: [{ input: observed.input, ...(pauses.length === 0 ? {} : { pauses }) }],
    required: requiredCallsOf(observed.toolCalls),
    ...(expectedStatus === undefined ? {} : { expectedStatus }),
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
    pauses: record.pauses,
    status: record.status,
  };
}
