import { END, Send, START, StateGraph, type BaseCheckpointSaver } from "@langchain/langgraph";
import { agentDefinitions } from "../../graph/agent-definitions.js";
import {
  agentLoopGraph,
  noJudges,
  pauseSeamApproval,
  type AgentDefinition,
  type AgentLoopGraph,
} from "../../graph/agent-loop/index.js";
import { RecursionDecider } from "../analyse/recursion.js";
import { lastLevelAnswerTools, recursiveBranchOf } from "./soft-stop.js";
import { agentRunner, type AgentLoops } from "./runners/agent.js";
import type { GraphDeps } from "../../graph/deps.js";
import type { Class } from "../../components/injection.js";
import type { BudgetMeter } from "../../budgets/execution-budgets.js";
import { NodeKind } from "../ast.js";
import { isCodeRouterNode, type RuntimeNode } from "./graph-model.js";
import type { NodeRunner } from "./node-runner.js";
import { actionRunner } from "./runners/action.js";
import { finishRunner } from "./runners/finish.js";
import { codeRouterRunner } from "./runners/code-router.js";
import { routerRunner } from "./runners/router.js";
import { startRunner } from "./runners/start.js";
import { branchNode } from "./launch/branch-runner.js";
import { branchInputOf } from "./launch/branch-view.js";
import { joinNode } from "./launch/join-node.js";
import { LAUNCH_NEXT } from "./launch/launch-exit.js";
import { ExecutionState, type ExecutionStateType, type ExecutionStateUpdate } from "./state.js";
import { visitNode } from "./visit.js";
import { childRunner, type ChildGraph } from "./child.js";
import { nodeDepsOf } from "./node-deps.js";
import { isThisWorkflow } from "../this-workflow.js";
import { nodeOptionsOf, recursiveChildOf, type OwnGraph } from "./recursive-child.js";

/**
 * One LangGraph `StateGraph` per workflow (#272 → Runtime): a node per component, its id the
 * component's `name`; the execution enters at the start it was given and every node's conditional
 * edge follows the way out it chose (`next`), a finish ending it. A parallel launch (#273 S20) sends
 * each of its branches as one `Send` of the same superstep to its node, and every branch goes on to
 * the launch's join node. LangGraph's `recursionLimit` is a safety net far above the steps limit,
 * never the limit a user sees.
 */

/** What one pass of an execution is held to besides its workflow's steps: its budgets (#261). */
export interface RunLimits {
  readonly budgets: BudgetMeter;
}

const RECURSION_SAFETY_FACTOR = 10;

class UnknownAgentError extends Error {
  override name = "UnknownAgentError";
}

/**
 * Every agent's loop, compiled once per graph (approval only with a pause seam); an agent whose
 * variants recurse gets a second loop for the last level, its recursive variants left out (#264).
 */
function agentLoops(deps: GraphDeps<string>, run: RunLimits): ReadonlyMap<string, AgentLoops> {
  const approval =
    deps.pause === undefined
      ? undefined
      : pauseSeamApproval({
          channelOf: deps.channelOf,
          pauses: deps.pause.pauses,
          observer: deps.observer,
        });
  const loopOf = (name: string, agent: AgentDefinition): AgentLoopGraph =>
    agentLoopGraph(
      {
        agent,
        bundle: deps.config.name,
        budgets: run.budgets,
        approval,
        judges: noJudges,
        ...(deps.pii === undefined ? {} : { pii: deps.pii.policiesOf(name) }),
        guardrails: deps.guardrails?.(name),
        workflowGuardrails: deps.workflowGuardrails,
        toolGuardrails: deps.toolGuardrails,
        observer: deps.observer,
      },
      deps.pause?.checkpointer,
    );
  const { recursion } = deps.graph.analysis;
  return new Map(
    [...agentDefinitions(deps)].map(([name, agent]) => {
      const branch = recursiveBranchOf(recursion, name, RecursionDecider.Agent);
      const loop = loopOf(name, agent);
      if (branch === undefined) return [name, { loop }] as const;
      const answerTools = lastLevelAnswerTools(agent.answerTools, branch);
      return [name, { loop, lastLevel: loopOf(name, { ...agent, answerTools }) }] as const;
    }),
  );
}

/** What a node's runner is made of: the agents' loops and the child workflows' graphs (#263). */
interface Parts {
  readonly loops: ReadonlyMap<string, AgentLoops>;
  readonly children: ReadonlyMap<string, ChildGraph>;
  readonly checkpointer?: BaseCheckpointSaver | undefined;
}

function runnerOf(node: RuntimeNode, deps: GraphDeps<string>, parts: Parts): NodeRunner {
  switch (node.kind) {
    case NodeKind.Start:
      return startRunner(deps);
    case NodeKind.Finish:
      return finishRunner(node, deps);
    case NodeKind.Action:
      return actionRunner(node, deps);
    case NodeKind.Router: {
      if (isCodeRouterNode(node)) return codeRouterRunner(node, deps);
      const router = deps.routers.find((loaded) => loaded.name === node.id);
      if (router === undefined) throw new UnknownAgentError(`No router texts for ${node.id}`);
      return routerRunner(node, router, deps.routerFor(router), deps);
    }
    case NodeKind.Agent:
    case NodeKind.Workflow:
      return subgraphRunnerOf(node, deps, parts);
  }
}

/** The runner of a node that runs a graph of its own: an agent's loop, a child workflow (#263). */
function subgraphRunnerOf(node: RuntimeNode, deps: GraphDeps<string>, parts: Parts): NodeRunner {
  if (node.kind === NodeKind.Agent) {
    const loops = parts.loops.get(node.id);
    if (loops === undefined) throw new UnknownAgentError(`Unknown agent: ${node.id}`);
    return agentRunner(node, loops, deps);
  }
  const child = parts.children.get(node.id);
  if (child === undefined) throw new UnknownAgentError(`Unknown child workflow: ${node.id}`);
  return childRunner(node, deps, child, parts.checkpointer);
}

/** A child workflow cannot be built: it runs only in its application, or it launches an ancestor. */
class ChildWorkflowUnavailableError extends Error {
  override name = "ChildWorkflowUnavailableError";
}

/**
 * The compiled graph of every child workflow of the graph for this pass (#263 S37): each with its
 * own deps, on the parent's budgets and checkpointer; `chain` — the workflows above — stops a
 * workflow from containing an ancestor (a recursion is `ThisWorkflow`, #264).
 */
function childGraphsOf(
  deps: GraphDeps<string>,
  run: RunLimits,
  checkpointer: BaseCheckpointSaver | undefined,
  chain: readonly Class[],
  self: OwnGraph,
): ReadonlyMap<string, ChildGraph> {
  const children = new Map<string, ChildGraph>();
  for (const node of deps.graph.nodes.values()) {
    if (node.kind !== NodeKind.Workflow) continue;
    if (isThisWorkflow(node.component)) {
      children.set(node.id, recursiveChildOf(deps, self));
      continue;
    }
    const childDeps = deps.childDepsOf?.(node.component);
    if (childDeps === undefined || chain.includes(node.component))
      throw new ChildWorkflowUnavailableError(
        `${deps.config.name}: ${node.id} runs only inside its application (createApp / testWith), and never inside itself`,
      );
    const graph = compile(childDeps, run, checkpointer, [...chain, deps.graph.type]);
    const { name, version } = childDeps.config;
    children.set(node.id, {
      deps: childDeps,
      graph,
      workflow: { type: node.component, name, version },
      isRecursive: false,
    });
  }
  return children;
}

/** Where a node's visit goes: the node it chose, the end, or one `Send` per branch of its launch. */
function nextOf(state: ExecutionStateType): string | Send[] {
  if (state.next === LAUNCH_NEXT)
    return (state.launch?.branches ?? []).map(
      (branch) => new Send(branch.node, branchInputOf(state, branch)),
    );
  return state.next === "" ? END : state.next;
}

function compile(
  deps: GraphDeps<string>,
  run: RunLimits,
  checkpointer?: BaseCheckpointSaver,
  chain: readonly Class[] = [],
) {
  const self: OwnGraph = {};
  const parts: Parts = {
    loops: agentLoops(deps, run),
    children: childGraphsOf(deps, run, checkpointer, chain, self),
    checkpointer,
  };
  const { visitDeps, launchDeps } = nodeDepsOf(deps, run, checkpointer);
  const nodes = [...deps.graph.nodes.values()];
  // node ids are the components' names, known only at run time: `string`, not literal types
  const graph = new StateGraph<
    typeof ExecutionState.spec,
    ExecutionStateType,
    ExecutionStateUpdate,
    string
  >(ExecutionState);
  for (const node of nodes) {
    const runner = runnerOf(node, deps, parts);
    const isBranch = deps.graph.branchNodes.has(node.id);
    const action = isBranch
      ? branchNode(node, runner, launchDeps)
      : visitNode(node, runner, visitDeps);
    graph.addNode(node.id, action, nodeOptionsOf(parts.children.get(node.id), deps));
  }
  for (const launch of deps.graph.launches)
    graph.addNode(launch.joinNodeId, joinNode(launch, launchDeps));
  const ids = [...nodes.map((node) => node.id), ...deps.graph.launches.map((l) => l.joinNodeId)];
  graph.addConditionalEdges(START, (state) => state.start, [...deps.graph.starts]);
  for (const id of ids) graph.addConditionalEdges(id, nextOf, [...ids, END]);
  const recursionLimit = (deps.maxSteps + ids.length) * RECURSION_SAFETY_FACTOR;
  const compiled = graph.compile(checkpointer === undefined ? {} : { checkpointer });
  const own = compiled.withConfig({ recursionLimit });
  self.graph = own;
  return own;
}

/** The compiled execution graph of a workflow. */
export type ExecutionGraph = ReturnType<typeof compile>;

/** Builds the workflow's graph for one pass of an execution (its budgets). */
export function executionGraphOf(deps: GraphDeps<string>, run: RunLimits): ExecutionGraph {
  return compile(deps, run, deps.pause?.checkpointer);
}
