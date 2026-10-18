import { extractRunContext } from "../../../core/run-context.js";
import { loopInputOf, loopResultOf, type AgentLoopGraph } from "../../../graph/agent-loop/index.js";
import type { GraphDeps } from "../../../graph/deps.js";
import type { RuntimeNode } from "../graph-model.js";
import { inputMessageOf } from "../input-message.js";
import type { NodeRunner } from "../node-runner.js";
import { stepNodeIdOf } from "../step-frame.js";
import { readInput, type NodeValue } from "../scope.js";

/**
 * An agent: its own loop (a subgraph — model turns, the move boundary, approvals, tool calls, its
 * answer, judges) on its input message (#270 Q51). Its value is its answer through an answer tool
 * (S6), or a text agent's reply as `WorkflowFinishTextDto`. A pause inside (`interrupt`) pauses the
 * execution; on resume the loop continues from its own checkpoint.
 */
export function agentRunner(
  node: RuntimeNode,
  loop: AgentLoopGraph,
  deps: GraphDeps<string>,
): NodeRunner {
  return async (state, config) => {
    const threadId = extractRunContext(config, state.runId).threadId;
    const name = stepNodeIdOf(node);
    const appState = { runId: state.runId, threadId, activeNode: name };
    const input = inputMessageOf(node.fields, state);
    await deps.observer?.onAgentStart({ name, input, state: appState });
    const result = loopResultOf(await loop.invoke(loopInputOf(state, node.id, input), config));
    const value: NodeValue = result.answer ?? { value: { text: result.reply } };
    await deps.observer?.onAgentEnd({ name, update: value, state: appState });
    const read = readInput(deps.graph, node, state).read;
    return { value, read, usage: result.usage, approvals: result.approvals };
  };
}
