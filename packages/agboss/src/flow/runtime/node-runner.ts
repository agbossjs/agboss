import type { RunnableConfig } from "@langchain/core/runnables";
import type { UsageRecord } from "../../finops/usage.js";
import type { ApprovalRecord } from "../../pause/index.js";
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
