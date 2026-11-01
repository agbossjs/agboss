import { isGraphInterrupt } from "@langchain/langgraph";
import { errorRecordOf } from "../../core/error-record.js";
import { handedOverOf, recordedHandOver } from "../../app/handed-over.js";
import { HandOverSite } from "../../infrastructure/execution-lease-event.repository.js";
import { errorHandlerOf, type RuntimeNode } from "./graph-model.js";
import { unrecordedSpendOf, type Reported } from "./node-runner.js";
import type { ExecutionStateUpdate } from "./state.js";
import { failedVisitOf, failureCarryingStep, type VisitSite } from "./visit-step.js";
import { handledErrorOf, type ComponentRecords } from "./workflow-keys.js";
import { sidePathEntered } from "./limits.js";

/** What every visit adds to the execution's counters: the path, its visits and its steps. */
export function visited(node: RuntimeNode, isStep: boolean): ExecutionStateUpdate {
  return { path: [node.id], visits: { [node.id]: 1 }, steps: isStep ? 1 : 0 };
}

/** A failure the node's `.onError` takes: kept as a record, the side path next; else rethrown. */
export function caught(
  deps: ComponentRecords,
  visit: VisitSite,
  error: unknown,
  { ranAsStep, reported }: { readonly ranAsStep: boolean; readonly reported: Reported },
  signal: AbortSignal | undefined,
): ExecutionStateUpdate {
  const { node } = visit;
  if (isGraphInterrupt(error)) throw error;
  // a lost lease, a fenced write or an interruption is no failure of the step: another instance
  // goes on (#265, #471) — a fenced error behind the failure first, rethrown as it is
  const handedOver = handedOverOf(error, signal);
  if (handedOver !== undefined) throw recordedHandOver(handedOver, HandOverSite.Step, visit.frame);
  const record = errorRecordOf(error);
  const handler = errorHandlerOf(node.exits, record);
  const usage = [...unrecordedSpendOf(error), ...reported.usage];
  if (handler === undefined) throw failureCarryingStep(visit, error, usage);
  return {
    ...visited(node, ranAsStep),
    lastError: record,
    next: handler.to,
    usage,
    ...failedVisitOf(visit, error, usage),
    children: [...reported.children],
    piiTokens: reported.piiTokens,
    handledErrors: [handledErrorOf(deps, record, node.id, handler.to)],
    ...sidePathEntered(visit.state, record, handler.to, node),
  };
}
