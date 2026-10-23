import type { RunnableConfig } from "@langchain/core/runnables";
import type { ErrorRecord } from "../../core/error-record.js";
import { extractRunContext } from "../../core/run-context.js";
import type { UsageRecord } from "../../finops/usage.js";
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
): (place: VisitPlace) => VisitSite {
  const { clock } = extractRunContext(config, runId);
  const startedAt = clock.now();
  return (place) => ({ ...place, startedAt, endedAt: clock.now() });
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
  readonly outcome?: Pick<NodeOutcome, "judgeVerdicts" | "guardrailDecisions">;
  readonly usage: readonly UsageRecord[];
  readonly error?: ErrorRecord;
}

/** The visit's one entry of `record.steps` (#395 C3), as the state's appended channel takes it. */
export function visitStepsOf(site: VisitSite, end: VisitEnd): ExecutionStepRecord[] {
  return [
    executionStepRecordOf({
      step: stepRecordOf(site.frame.step),
      input: inputOf(site),
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
