import type { RunnableConfig } from "@langchain/core/runnables";
import { RunnableLambda } from "@langchain/core/runnables";
import type { ObserverManager } from "../../../core/observer-manager.js";
import type { ErrorRecord } from "../../../core/error-record.js";
import type { ExecutionFacts, FrameSpec } from "../../context/frame.js";
import type { LaunchItemsTruncatedEvent } from "../../observers/launch-items-truncated.js";
import type { BranchStatus, BranchTicket, LaunchTicket } from "./records.js";

/**
 * What a launch tells the world (#273): one trace entry per branch when it ends — a child run of
 * the branch's task named by its copy id or item (`critic-agent#2`, `company-check-agent[3]`), with
 * its launch, copy number, item index and status — and, when a per-item launch dropped items, a
 * trace entry "launch items truncated" and the `onLaunchItemsTruncated` event. No DTO values.
 */

/** The trace entry of one ended branch. */
export interface BranchTrace {
  readonly launch: string;
  readonly nodeId: string;
  readonly copyNumber: number;
  readonly itemIndex?: number;
  readonly status: BranchStatus;
  /** A failed, skipped or cancelled branch's error: its code and message. */
  readonly error?: Pick<ErrorRecord, "code" | "message">;
}

const traceEntry = RunnableLambda.from((trace: object) => trace);

async function traced(config: RunnableConfig | undefined, runName: string, trace: object) {
  const parent = config ?? {};
  await traceEntry.invoke(trace, {
    callbacks: parent.callbacks,
    tags: parent.tags,
    metadata: parent.metadata,
    runName,
  });
}

/** `critic-agent#2` for a copy, `company-check-agent[3]` for an item. */
export const branchLabelOf = (ticket: BranchTicket): string =>
  ticket.itemIndex === undefined ? ticket.nodeId : `${ticket.nodeId}[${String(ticket.itemIndex)}]`;

/** The trace entry of a branch that ended. */
export function reportBranch(
  config: RunnableConfig | undefined,
  launch: string,
  ticket: BranchTicket,
  ended: { readonly status: BranchStatus; readonly error?: ErrorRecord },
): Promise<void> {
  const trace: BranchTrace = {
    launch,
    nodeId: ticket.nodeId,
    copyNumber: ticket.copyNumber,
    ...(ticket.itemIndex === undefined ? {} : { itemIndex: ticket.itemIndex }),
    status: ended.status,
    ...(ended.error === undefined
      ? {}
      : { error: { code: ended.error.code, message: ended.error.message } }),
  };
  return traced(config, branchLabelOf(ticket), trace);
}

/** Where a launch is reported from: the launching step's frame and the observers. */
export interface LaunchReportSite {
  readonly observer?: ObserverManager;
  readonly config?: RunnableConfig;
  readonly frame: FrameSpec;
}

function truncatedEvent(
  execution: ExecutionFacts,
  frame: FrameSpec,
  ticket: LaunchTicket,
  maxItems: number,
): LaunchItemsTruncatedEvent {
  const { executionId, threadId, workflow } = execution;
  const { name, version, startedVersion } = workflow;
  return {
    executionId,
    parentExecutionId: undefined,
    rootExecutionId: executionId,
    threadId,
    workflow: { name, version, startedVersion },
    step: { ...frame.step, component: { name: frame.step.component.name } },
    launch: ticket.launchId,
    items: ticket.items,
    maxItems,
  };
}

/** A per-item launch that took fewer items than its list had: the trace entry and the event. */
export async function reportTruncation(
  site: LaunchReportSite,
  ticket: LaunchTicket,
  maxItems: number | undefined,
): Promise<void> {
  if (maxItems === undefined || ticket.items <= maxItems) return;
  const event = truncatedEvent(site.frame.execution, site.frame, ticket, maxItems);
  const { launch, items } = event;
  await traced(site.config, "launch items truncated", { launch, items, maxItems });
  await site.observer?.onLaunchItemsTruncated(event);
}
