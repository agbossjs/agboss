import type { ChildExecutionRecord, ExecutionHistoryRecord, ToolCallRecord } from "@agboss/core";
import type { HubRecord } from "./hub-inputs.js";

/**
 * The calls between applications the records saw (#401 PR 3, the report's "observed edges"): a
 * caller's tool call that ran a remote AGBoss execution (`ToolCallRecord.remote`, #398 PR 2), and a
 * receiver's own record of who called it (`origin`). One call is seen from both sides when both
 * applications exported their records — the step's idempotency key (the call's own) is the same on
 * both, so it is counted once.
 */

/** One call from an application to another, as one side saw it. */
export interface ObservedCall {
  /** The calling step's idempotency key: one call, one key, on both sides. */
  readonly key: string;
  readonly from: string;
  readonly to: string;
  /** The workflow that called. */
  readonly workflow: string;
  /** The calling tool, when the caller's record saw it. */
  readonly tool?: string;
}

/** What made a call, from the caller's side: a root's or a child's tool calls, with its workflow. */
interface CallingExecution {
  readonly workflow: { readonly name: string };
  readonly toolCalls: readonly ToolCallRecord[];
  readonly children: readonly ChildExecutionRecord[];
}

function callerCalls(application: string, execution: CallingExecution): ObservedCall[] {
  const own = execution.toolCalls.flatMap((call): ObservedCall[] =>
    call.remote === undefined
      ? []
      : [
          {
            key: call.step.idempotencyKey,
            from: application,
            to: call.remote.application,
            workflow: execution.workflow.name,
            tool: call.step.component.name,
          },
        ],
  );
  return [...own, ...execution.children.flatMap((child) => callerCalls(application, child))];
}

const receiverCall = (record: ExecutionHistoryRecord): ObservedCall[] =>
  record.origin === undefined
    ? []
    : [
        {
          key: record.origin.step.idempotencyKey,
          from: record.origin.application,
          to: record.application.name,
          workflow: record.origin.workflow.name,
        },
      ];

/** Every call the records saw, each once (by its key), the caller's view first. */
export function observedCallsOf(records: readonly HubRecord[]): ObservedCall[] {
  const calls = records.flatMap(({ record }) => [
    ...callerCalls(record.application.name, record),
    ...receiverCall(record),
  ]);
  const byKey = new Map<string, ObservedCall>();
  for (const call of calls) {
    const seen = byKey.get(call.key);
    if (seen === undefined || (seen.tool === undefined && call.tool !== undefined))
      byKey.set(call.key, call);
  }
  return [...byKey.values()];
}

/** The calls between two applications, gathered. */
export interface ObservedEdge {
  readonly from: string;
  readonly to: string;
  readonly calls: number;
  /** The calling workflows and tools, sorted. */
  readonly workflows: readonly string[];
  readonly tools: readonly string[];
}

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();

/** The edges of the calls: one per caller and receiver, sorted by both. */
export function observedEdgesOf(calls: readonly ObservedCall[]): ObservedEdge[] {
  const groups = new Map<string, ObservedCall[]>();
  for (const call of calls) {
    const key = `${call.from}\u0000${call.to}`;
    groups.set(key, [...(groups.get(key) ?? []), call]);
  }
  return [...groups.values()]
    .map((group) => {
      const [first] = group;
      return {
        from: first?.from ?? "",
        to: first?.to ?? "",
        calls: group.length,
        workflows: sorted(group.map((call) => call.workflow)),
        tools: sorted(group.flatMap((call) => (call.tool === undefined ? [] : [call.tool]))),
      };
    })
    .sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
}
