import { reportNodeEvent } from "../../observers/execution-event.js";
import { loopInputOf, loopResultOf, type AgentLoopGraph } from "../../../graph/agent-loop/index.js";
import type { GraphDeps } from "../../../graph/deps.js";
import type { RuntimeNode } from "../graph-model.js";
import type { NodeRunner } from "../node-runner.js";
import { stepNodeIdOf } from "../step-frame.js";
import { readInput, type NodeValue } from "../scope.js";
import { boundaryInputOf } from "./boundary-input.js";
import { isLastLevel } from "../soft-stop.js";
import { GuardrailSide } from "../../../components/policy-decorators.js";
import { runGuardrails } from "../../../guardrails/runtime.js";
import { maskedModelText } from "../../../pii/model-boundary.js";
import type { UsageRecord } from "../../../finops/usage.js";
import type { PiiTokenMap } from "../../../pii/tokens.js";
import type { LoopPii, LoopResult } from "../../../graph/agent-loop/runner.js";

/** An agent's loops: its own, and the last level's of a recursive workflow (#264). */
export interface AgentLoops {
  readonly loop: AgentLoopGraph;
  /** Its recursive variants left out of the response schema (`soft-stop.ts`). */
  readonly lastLevel?: AgentLoopGraph;
}

/**
 * The agent's output guardrails (#120) on its answer — its text, or its answer's JSON — masked by
 * its PII policies as its model would read it: their spend (a block fails the execution).
 */
async function guardedAnswer(
  name: string,
  result: LoopResult,
  pii: { readonly loop: LoopPii; readonly tokens: PiiTokenMap },
  deps: GraphDeps<string>,
): Promise<readonly UsageRecord[]> {
  const guardrails = deps.guardrails?.outputOf(name) ?? [];
  if (guardrails.length === 0) return [];
  const set = deps.pii?.policiesOf(name).withValues(pii.loop.values);
  const masked =
    set === undefined
      ? { text: result.reply, usage: [] }
      : await maskedModelText(set, result.reply, pii.tokens);
  const checked = { text: masked.text, element: name, side: GuardrailSide.Output };
  return [...masked.usage, ...(await runGuardrails(guardrails, checked, deps.observer))];
}

/**
 * An agent: its own loop (a subgraph — model turns, the move boundary, approvals, tool calls, its
 * answer, judges) on its input message (#270 Q51), its `sensitive` fields masked (#120); its input
 * guardrails run in the loop, its output guardrails on the answer it leaves with. Its value is its
 * answer through an answer tool (S6), or a text agent's reply as `WorkflowFinishTextDto`. A pause
 * inside (`interrupt`) pauses the execution; on resume the loop continues from its own checkpoint.
 */
export function agentRunner(
  node: RuntimeNode,
  loops: AgentLoops,
  deps: GraphDeps<string>,
): NodeRunner {
  return async (state, config) => {
    const name = stepNodeIdOf(node);
    // the soft stop (#264): on the last level, the loop without the recursive variants
    const loop =
      loops.lastLevel !== undefined && isLastLevel(deps.graph) ? loops.lastLevel : loops.loop;
    const { input, pii } = boundaryInputOf(node, state, deps.pii);
    await reportNodeEvent((base) => deps.observer?.onAgentStart({ ...base, name, input }));
    const after = await loop.invoke(loopInputOf(state, node.id, input, pii), config);
    const result = loopResultOf(after);
    const guarded = await guardedAnswer(
      node.id,
      result,
      { loop: pii, tokens: result.piiTokens },
      deps,
    );
    const value: NodeValue = result.answer ?? { value: { text: result.reply } };
    await reportNodeEvent((base) => deps.observer?.onAgentEnd({ ...base, name, update: value }));
    const read = readInput(deps.graph, node, state).read;
    const { approvals, piiTokens } = result;
    return { value, read, usage: [...result.usage, ...guarded], approvals, piiTokens };
  };
}
