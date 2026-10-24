import type { RunnableConfig } from "@langchain/core/runnables";
import { errorRecordOf, type ErrorRecord } from "../../core/error-record.js";
import { carriedRecordsOf, carryRecords } from "./carried-records.js";
import type { ToolCallRecord } from "./tool-calls.js";
import { extractRunContext } from "../../core/run-context.js";
import type { UsageRecord } from "../../finops/usage.js";
import { versionOf } from "../../terns/index.js";
import { NodeKind } from "../ast.js";
import type { FrameSpec } from "../context/frame.js";
import { stepRecordOf } from "../observers/execution-event.js";
import type { RuntimeNode } from "./graph-model.js";
import type { NodeOutcome } from "./node-runner.js";
import type { ExecutionStateType } from "./state.js";
import { executionStepRecordOf, type ExecutionStepRecord } from "./step-records.js";

/** Where a visit ran: its frame, its node and the state (or a branch's view) it read. */
export interface VisitSite {
  readonly frame: FrameSpec;
  readonly node: RuntimeNode;
  readonly state: ExecutionStateType;
  readonly startedAt: Date;
  readonly endedAt: Date;
}

/** When and in which frame a visit ran (#395): its step's record is made of them. */
export interface VisitAt {
  readonly executionId: string;
  readonly now: Date;
  readonly frame: FrameSpec;
  readonly startedAt: Date;
}

/** Where a visit ran, before its times are known. */
export type VisitPlace = Omit<VisitSite, "startedAt" | "endedAt">;

/** A visit's timer on the application's clock: started now, its site with its end when called. */
export function visitTimerOf(
  config: RunnableConfig | undefined,
  runId: string,
  place: VisitPlace,
): () => VisitSite {
  const { clock } = extractRunContext(config, runId);
  const startedAt = clock.now();
  return () => ({ ...place, startedAt, endedAt: clock.now() });
}

/**
 * What a visit read, as plain data: a start its input, every other node the scope's value of each
 * of its `input` fields (as the scope keeps it — JSON, the same in every pass).
 */
function inputOf(site: VisitSite): unknown {
  if (site.node.kind === NodeKind.Start) return site.state.startInput;
  const read = site.node.fields.flatMap((field): [string, unknown][] => {
    const record = site.state.scope[field.slot];
    return record === undefined ? [] : [[field.name, record.value]];
  });
  return Object.fromEntries(read);
}

/** How a visit ended for its record: what it decided and spent, or the failure a side path took. */
export interface VisitEnd {
  readonly outcome?: Pick<
    NodeOutcome,
    "judgeVerdicts" | "guardrailDecisions" | "route" | "launch" | "value"
  >;
  readonly usage: readonly UsageRecord[];
  readonly error?: ErrorRecord;
}

/**
 * What a visit decided (#401 PR 5): a router's route or launched routes, a `oneOf` answer's class,
 * else a hash of the value it gave; none when it gave nothing.
 */
export function decisionOf(outcome: VisitEnd["outcome"]): string | undefined {
  if (outcome?.route !== undefined) return `route:${outcome.route}`;
  if (outcome?.launch !== undefined) return `launch:${[...outcome.launch].sort().join(",")}`;
  if (outcome?.value === undefined) return undefined;
  if (outcome.value.variant !== undefined) return `variant:${outcome.value.variant}`;
  return `answer:${versionOf(outcome.value.value ?? null)}`;
}

/** The visit's one entry of `record.steps` (#395 C3), as the state's appended channel takes it. */
export function visitStepsOf(site: VisitSite, end: VisitEnd): ExecutionStepRecord[] {
  return [
    executionStepRecordOf({
      step: stepRecordOf(site.frame.step),
      input: inputOf(site),
      decision: end.error === undefined ? decisionOf(end.outcome) : undefined,
      usage: end.usage,
      judgeVerdicts: end.outcome?.judgeVerdicts,
      guardrailDecisions: end.outcome?.guardrailDecisions,
      startedAt: site.startedAt,
      endedAt: site.endedAt,
      ...(end.error === undefined ? {} : { error: end.error }),
    }),
  ];
}

/** The entry of a visit that succeeded: what its node decided and spent. */
export const succeededStepsOf = (site: VisitSite, outcome: NodeOutcome): ExecutionStepRecord[] =>
  visitStepsOf(site, { outcome, usage: outcome.usage ?? [] });

/** What a failed visit records (#395 S6): the tool calls and the step its failure carries. */
export interface FailedVisitRecords {
  readonly toolCalls: ToolCallRecord[];
  readonly stepRecords: ExecutionStepRecord[];
}

/** The records of a visit whose failure a side path (or a failed branch) records. */
export function failedVisitOf(
  site: VisitSite | undefined,
  error: unknown,
  usage: readonly UsageRecord[],
): FailedVisitRecords {
  const carried = carriedRecordsOf(error);
  // a branch that failed before its frame was made: nothing of its visit to record
  if (site === undefined) return { toolCalls: [...carried.toolCalls], stepRecords: [] };
  const end = { outcome: carried, usage, error: errorRecordOf(error) };
  return { toolCalls: [...carried.toolCalls], stepRecords: visitStepsOf(site, end) };
}

/**
 * A failure no side path takes, carrying its visit's step (#395 S6): the child execution it ends
 * records it with the calls the failure carries.
 */
export function failureCarryingStep(
  site: VisitSite,
  error: unknown,
  usage: readonly UsageRecord[],
): unknown {
  carryRecords(error, { steps: failedVisitOf(site, error, usage).stepRecords });
  return error;
}
