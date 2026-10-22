import type { RunnableConfig } from "@langchain/core/runnables";
import type { UsageRecord } from "../../finops/usage.js";
import { PaidStepError } from "../../graph/errors.js";
import { LimitExceededError } from "../../graph/limits.js";
import type { FrameServices } from "../context/frame.js";
import type { EndedChildRecord } from "./child-records.js";
import type { RuntimeNode } from "./graph-model.js";
import { countedServiceSpend, type ExecutionLimits } from "./limits.js";
import type { ApprovalRecord } from "../../pause/index.js";
import type { PiiTokenMap } from "../../pii/tokens.js";
import type { CompensationEntry } from "../compensation.js";
import type { NodeValue } from "./scope.js";
import type { ExecutionStateType, ExecutionStateUpdate } from "./state.js";

/**
 * What one visit of a node gave the execution (#272 → Runtime): its value (written to the scope by
 * the edge taken), the route a router chose, the finish output, what it read and what it spent.
 */
export interface NodeOutcome {
  /** The node's output (a start's input, an agent's answer, an action's result). */
  readonly value?: NodeValue;
  /** The node id a router chose. */
  readonly route?: string;
  /** The `OnDemand` targets (node ids) a router before a launch chose to launch (#273). */
  readonly launch?: readonly string[];
  /** A finish: the execution's output DTO. */
  readonly finish?: { readonly output: unknown };
  /** The `valueId`s the node read (the `builtFrom` of what it writes). */
  readonly read: readonly string[];
  readonly usage?: readonly UsageRecord[];
  readonly approvals?: readonly ApprovalRecord[];
  /** The PII tokens its model boundary made (#120): added to the execution's by key. */
  readonly piiTokens?: PiiTokenMap;
}

/** Runs one node: an agent's loop, a router's decision, an action's or a finish's handler, … */
export type NodeRunner = (
  state: ExecutionStateType,
  config?: RunnableConfig,
) => Promise<NodeOutcome>;

/** A node of the LangGraph graph: the execution state in, the keys it owns out. */
export type GraphNode = (
  state: ExecutionStateType,
  config?: RunnableConfig,
) => Promise<ExecutionStateUpdate>;

/** What a visit adds to the execution's appended channels: its spend, decisions and PII tokens. */
export interface VisitRecords {
  readonly usage: UsageRecord[];
  readonly approvals: ApprovalRecord[];
  readonly piiTokens: PiiTokenMap;
}

export const recordsOf = (outcome: NodeOutcome): VisitRecords => ({
  usage: [...(outcome.usage ?? [])],
  approvals: [...(outcome.approvals ?? [])],
  piiTokens: outcome.piiTokens ?? {},
});

/** Spend a failure carries that the execution's state does not hold yet. */
export const unrecordedSpendOf = (error: unknown): readonly UsageRecord[] =>
  error instanceof PaidStepError || error instanceof LimitExceededError ? error.usage : [];

/** What a visit's code reported besides its outcome: services' spend, ended child executions. */
export interface Reported {
  readonly usage: UsageRecord[];
  readonly children: EndedChildRecord[];
  /** A failed child's PII tokens (#120): kept with its error. */
  piiTokens: PiiTokenMap;
  /** A failed child's entries its automatic undo closed (#340): kept with its error. */
  readonly compensations: CompensationEntry[];
}

/** What a visit's code reports through its frame's services, and the services that collect it. */
export function reportingOf(
  limits: ExecutionLimits,
  node: RuntimeNode,
  path: readonly string[],
): { readonly reported: Reported; readonly services: FrameServices } {
  const reported: Reported = { usage: [], children: [], piiTokens: {}, compensations: [] };
  const services: FrameServices = {
    reportUsage: (record: UsageRecord): void => {
      reported.usage.push(countedServiceSpend(limits, node, path, record));
    },
    recordChild: (record: EndedChildRecord): void => {
      reported.children.push(record);
    },
    keepPiiTokens: (tokens: PiiTokenMap): void => {
      reported.piiTokens = { ...reported.piiTokens, ...tokens };
    },
    keepCompensations: (entries: readonly CompensationEntry[]): void => {
      reported.compensations.push(...entries);
    },
  };
  return { reported, services };
}
