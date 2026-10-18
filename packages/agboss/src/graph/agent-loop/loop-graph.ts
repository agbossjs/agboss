import { END, START, StateGraph, type BaseCheckpointSaver } from "@langchain/langgraph";
import { makeAnswerNode } from "./answer-node.js";
import { makeJudgeNode } from "./judge-node.js";
import { makeApprovalNode } from "./approval-node.js";
import { makeBoundaryNode, routeToActions } from "./boundary.js";
import { makeCollectNode } from "./collect-node.js";
import { callsOf, isAnswerCall, type AgentLoopDeps } from "./deps.js";
import { makeInputNode } from "./input-node.js";
import { makeModelNode } from "./model-node.js";
import { makeReplyNode } from "./reply-node.js";
import { AgentLoopState, LOOP_NODE, type AgentLoopStateType, type ToolTask } from "./state.js";
import { makeToolNode } from "./tools-node.js";

/**
 * After a model turn: an answer tool → the answer; other tool calls → the boundary; none → the
 * reply; no move (an invalid answer — a token nobody gave it, #120) → the model again.
 */
export const afterModel =
  (deps: AgentLoopDeps) =>
  (state: AgentLoopStateType): string => {
    if (state.move === null) return LOOP_NODE.model;
    const calls = callsOf(state.move);
    if (calls.length === 0) return LOOP_NODE.reply;
    return calls.some((call) => isAnswerCall(deps.agent, call))
      ? LOOP_NODE.answer
      : LOOP_NODE.boundary;
  };

/** After the reply or the answer node: judged when it answered, else the model tries again. */
const afterAnswer = (state: AgentLoopStateType): string =>
  state.reply === null ? LOOP_NODE.model : LOOP_NODE.judge;

const ACTIONS = [LOOP_NODE.approval, LOOP_NODE.tool, LOOP_NODE.collect];

function createLoopGraph(deps: AgentLoopDeps, checkpointer: BaseCheckpointSaver | undefined) {
  return new StateGraph(AgentLoopState)
    .addNode(LOOP_NODE.input, makeInputNode(deps))
    .addNode(LOOP_NODE.model, makeModelNode(deps))
    .addNode(LOOP_NODE.boundary, makeBoundaryNode(deps))
    .addNode(LOOP_NODE.approval, makeApprovalNode(deps))
    .addNode<typeof LOOP_NODE.tool, ToolTask>(LOOP_NODE.tool, makeToolNode(deps))
    .addNode(LOOP_NODE.collect, makeCollectNode(deps))
    .addNode(LOOP_NODE.reply, makeReplyNode(deps))
    .addNode(LOOP_NODE.answer, makeAnswerNode(deps))
    .addNode(LOOP_NODE.judge, makeJudgeNode(deps))
    .addEdge(START, LOOP_NODE.input)
    .addEdge(LOOP_NODE.input, LOOP_NODE.model)
    .addConditionalEdges(LOOP_NODE.model, afterModel(deps), [
      LOOP_NODE.model,
      LOOP_NODE.boundary,
      LOOP_NODE.reply,
      LOOP_NODE.answer,
    ])
    .addConditionalEdges(LOOP_NODE.boundary, routeToActions(deps), ACTIONS)
    .addConditionalEdges(LOOP_NODE.approval, routeToActions(deps), ACTIONS)
    .addEdge(LOOP_NODE.tool, LOOP_NODE.collect)
    .addEdge(LOOP_NODE.collect, LOOP_NODE.model)
    .addConditionalEdges(LOOP_NODE.reply, afterAnswer, [LOOP_NODE.model, LOOP_NODE.judge])
    .addConditionalEdges(LOOP_NODE.answer, afterAnswer, [LOOP_NODE.model, LOOP_NODE.judge])
    .addConditionalEdges(
      LOOP_NODE.judge,
      (state) => (state.reply === null ? LOOP_NODE.model : END),
      [LOOP_NODE.model, END],
    )
    .compile(checkpointer === undefined ? {} : { checkpointer });
}

/** An agent's loop, compiled. */
export type AgentLoopGraph = ReturnType<typeof createLoopGraph>;

/**
 * One agent's own loop as a compiled subgraph: input → model → boundary → (approval ⟲) → tool × N
 * (`Send`) → collect → model … → reply or answer → judge. Added inside one node of the workflow
 * graph, it checkpoints through the run's checkpointer (a checkpointer given here makes it a graph
 * of its own, as in tests).
 */
export function agentLoopGraph(
  deps: AgentLoopDeps,
  checkpointer?: BaseCheckpointSaver,
): AgentLoopGraph {
  return createLoopGraph(deps, checkpointer);
}
