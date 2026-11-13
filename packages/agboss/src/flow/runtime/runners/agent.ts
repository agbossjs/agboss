import type { RunnableConfig } from "@langchain/core/runnables";
import { reportNodeEvent } from "../../observers/execution-event.js";
import type { ExecutionStateType } from "../state.js";
import { loopInputOf, loopResultOf, type AgentLoopGraph } from "../../../graph/agent-loop/index.js";
import type { GraphDeps } from "../../../graph/deps.js";
import type { RuntimeNode } from "../graph-model.js";
import type { NodeRunner } from "../node-runner.js";
import { stepNodeIdOf, visitNumberOf } from "../step-frame.js";
import { readInput, type NodeValue } from "../scope.js";
import { boundaryInputOf } from "./boundary-input.js";
import { isLastLevel } from "../soft-stop.js";
import { GuardrailSide } from "../../../components/policy-decorators.js";
import { runGuardrails, type GuardrailsPassed } from "../../../guardrails/runtime.js";
import { maskedModelText } from "../../../pii/model-boundary.js";
import { CarriedOrder, carryRecords } from "../carried-records.js";
import type { PiiTokenMap } from "../../../pii/tokens.js";
import type { LoopPii, LoopResult } from "../../../graph/agent-loop/runner.js";
import { currentFrame } from "../../context/frame.js";
import { extractRunContext } from "../../../core/run-context.js";
import { AgentStream, withAgentStream, type StepSite } from "../../../run/stream/agent-stream.js";

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
): Promise<GuardrailsPassed> {
  const guardrails = deps.guardrails?.outputOf(name) ?? [];
  if (guardrails.length === 0) return { usage: [], decisions: [] };
  const set = deps.pii?.policiesOf(name).withValues(pii.loop.values).withFieldKey(pii.loop.key);
  const masked =
    set === undefined
      ? { text: result.reply, usage: [] }
      : await maskedModelText(set, result.reply, pii.tokens);
  const checked = { text: masked.text, element: name, side: GuardrailSide.Output };
  const passed = await runGuardrails(guardrails, checked, deps.observer);
  return { usage: [...masked.usage, ...passed.usage], decisions: passed.decisions };
}

/**
 * The stream of this visit (#1006): where it is — node, visit, execution (and item) —, and whether
 * its text is held back: an agent with a blocking output check (an output guardrail, a PII policy
 * with a block rule) shows nothing before its checks passed. None without `onStream`.
 */
function visitStreamOf(
  node: RuntimeNode,
  state: ExecutionStateType,
  config: RunnableConfig | undefined,
  deps: GraphDeps<string>,
): AgentStream | undefined {
  const { stream } = extractRunContext(config, state.runId).run;
  if (stream === undefined) return undefined;
  return new AgentStream(stream, siteOf(node, state), holdsBack(node, deps));
}

/** Where the visit is: its node, its visit number, the execution (and the item) that makes it. */
function siteOf(node: RuntimeNode, state: ExecutionStateType): StepSite {
  const frame = currentFrame();
  const item = frame?.step.itemIndex;
  const execution = frame?.execution.executionId ?? state.runId;
  return {
    agent: stepNodeIdOf(node),
    visit: frame?.step.visitNumber ?? visitNumberOf(node, state),
    branch: item === undefined ? execution : `${execution}:${String(item)}`,
  };
}

/** Whether the agent has a blocking output check: an output guardrail, a PII block rule. */
const holdsBack = (node: RuntimeNode, deps: GraphDeps<string>): boolean =>
  (deps.guardrails?.outputOf(node.id) ?? []).length > 0 ||
  deps.pii?.policiesOf(node.id).blocks === true;

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
    const streamed = visitStreamOf(node, state, config, deps);
    const after = await loop
      .invoke(loopInputOf(state, node.id, input, pii), withAgentStream(config, streamed))
      .catch((error: unknown) => {
        streamed?.fail();
        throw error;
      });
    const result = loopResultOf(after);
    const guarded = await guardedAnswer(
      node.id,
      result,
      { loop: pii, tokens: result.piiTokens },
      deps,
    ).catch((error: unknown) => {
      streamed?.fail();
      // an output guardrail blocked the answer: the visit's records go with its failure (#395 S6)
      const { toolCalls, judgeVerdicts, guardrailDecisions } = result;
      carryRecords(error, { toolCalls, judgeVerdicts, guardrailDecisions }, CarriedOrder.Before);
      throw error;
    });
    // every check of the answer passed: what was held back goes out now (#1006)
    streamed?.release();
    const value: NodeValue = result.answer ?? { value: { text: result.reply } };
    await reportNodeEvent((base) => deps.observer?.onAgentEnd({ ...base, name, update: value }));
    const read = readInput(deps.graph, node, state).read;
    const { approvals, piiTokens, toolCalls, judgeVerdicts } = result;
    const usage = [...result.usage, ...guarded.usage];
    const guardrailDecisions = [...result.guardrailDecisions, ...guarded.decisions];
    const records = { toolCalls, judgeVerdicts, guardrailDecisions };
    return { value, read, usage, approvals, piiTokens, ...records };
  };
}
