import { END, START, Send, StateGraph, type BaseCheckpointSaver } from "@langchain/langgraph";
import {
  awaitingApproval,
  makeApprovalNode,
  makeCollectNode,
  makeToolNode,
  runnableCalls,
} from "./act-nodes.js";
import { makeModelNode } from "./model-node.js";
import { makeReviewNode } from "./review-node.js";
import { LoopState, NODE, type LoopStateType, type ToolTask } from "./state.js";
import type { LoopAgent } from "./types.js";

/** After review / approval: ask a person, fan the runnable calls out, or collect straight away. */
export function routeToActions(agent: LoopAgent): (state: LoopStateType) => string | Send[] {
  return (state) => {
    if (awaitingApproval(state, agent).length > 0) return NODE.approval;
    const calls = runnableCalls(state);
    if (calls.length === 0) return NODE.collect;
    return calls.map(
      (call) => new Send(NODE.tool, { callId: call.callId, tool: call.tool, args: call.args }),
    );
  };
}

/** After review: the answer ends the step, a returned move goes back to the model, else act. */
export function routeAfterReview(agent: LoopAgent): (state: LoopStateType) => string | Send[] {
  const act = routeToActions(agent);
  return (state) => {
    if (state.answer !== null) return END;
    if (state.move === null) return NODE.model;
    return act(state);
  };
}

const createLoopGraph = (agent: LoopAgent, checkpointer: BaseCheckpointSaver) =>
  new StateGraph(LoopState)
    .addNode(NODE.model, makeModelNode(agent))
    .addNode(NODE.review, makeReviewNode(agent))
    .addNode(NODE.approval, makeApprovalNode(agent))
    .addNode<typeof NODE.tool, ToolTask>(NODE.tool, makeToolNode(agent))
    .addNode(NODE.collect, makeCollectNode(agent))
    .addEdge(START, NODE.model)
    .addEdge(NODE.model, NODE.review)
    .addConditionalEdges(NODE.review, routeAfterReview(agent), [
      NODE.model,
      NODE.approval,
      NODE.tool,
      NODE.collect,
      END,
    ])
    .addConditionalEdges(NODE.approval, routeToActions(agent), [
      NODE.approval,
      NODE.tool,
      NODE.collect,
    ])
    .addEdge(NODE.tool, NODE.collect)
    .addEdge(NODE.collect, NODE.model)
    .compile({ checkpointer });

export type LoopGraph = ReturnType<typeof createLoopGraph>;

/** model → review → (approval ⟲) → tool × N (Send) → collect → model … → END at an accepted answer. */
export function buildLoopGraph(agent: LoopAgent, checkpointer: BaseCheckpointSaver): LoopGraph {
  return createLoopGraph(agent, checkpointer);
}
