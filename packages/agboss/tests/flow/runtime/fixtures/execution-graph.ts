import { END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import type { ExecutionGraph } from "../../../../src/flow/runtime/build.js";
import {
  ExecutionState,
  type ExecutionStateType,
  type ExecutionStateUpdate,
} from "../../../../src/flow/runtime/state.js";

/**
 * A real compiled execution graph of one node that does nothing, over its own checkpointer: what a
 * unit gives where the code under test only passes the graph on or reads its checkpointer and state.
 */
export function trivialExecutionGraph(checkpointer = new MemorySaver()): ExecutionGraph {
  const graph = new StateGraph<
    typeof ExecutionState.spec,
    ExecutionStateType,
    ExecutionStateUpdate,
    string
  >(ExecutionState);
  graph.addNode("child-node", () => ({}));
  graph.addEdge(START, "child-node");
  graph.addEdge("child-node", END);
  return graph.compile({ checkpointer }).withConfig({ recursionLimit: 1 });
}
