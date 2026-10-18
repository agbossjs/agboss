import { END, Send, START, StateGraph, type BaseCheckpointSaver } from "@langchain/langgraph";
import { agentDefinitions } from "../../graph/agent-definitions.js";
import { agentLoopGraph, noJudges, pauseSeamApproval } from "../../graph/agent-loop/index.js";
import type { GraphDeps } from "../../graph/deps.js";
import type { ResolvedLimits } from "../../graph/limits.js";
import type { WorkflowLimits } from "../../graph/settings.js";
import { NodeKind } from "../ast.js";
import { isCodeRouterNode, type RuntimeNode } from "./graph-model.js";
import type { NodeRunner } from "./node-runner.js";
import { actionRunner } from "./runners/action.js";
import { agentRunner } from "./runners/agent.js";
import { finishRunner } from "./runners/finish.js";
import { codeRouterRunner } from "./runners/code-router.js";
import { routerRunner } from "./runners/router.js";
import { startRunner } from "./runners/start.js";
import { branchNode } from "./launch/branch-runner.js";
import { branchInputOf } from "./launch/branch-view.js";
import { joinNode } from "./launch/join-node.js";
import { LAUNCH_NEXT } from "./launch/launch-exit.js";
import { LaunchRegistry } from "./launch/launch-registry.js";
import { ExecutionState, type ExecutionStateType, type ExecutionStateUpdate } from "./state.js";
import { visitNode, type SpentToday } from "./visit.js";

/**
 * One LangGraph `StateGraph` per workflow (#272 → Runtime): a node per component, its id the
 * component's `name`; the execution enters at the start it was given and every node's conditional
 * edge follows the way out it chose (`next`), a finish ending it. A parallel launch (#273 S20) sends
 * each of its branches as one `Send` of the same superstep to its node, and every branch goes on to
 * the launch's join node. LangGraph's `recursionLimit` is a safety net far above the steps limit,
 * never the limit a user sees.
 */

/** The limits one execution is held to and the spend of its account today. */
export interface RunLimits {
  readonly limits: WorkflowLimits;
  readonly spentToday: SpentToday;
}

const RECURSION_SAFETY_FACTOR = 10;

class UnknownAgentError extends Error {
  override name = "UnknownAgentError";
}

/** Every agent's loop, compiled once per graph (approval only with a pause seam). */
function agentLoops(deps: GraphDeps<string>) {
  const approval =
    deps.pause === undefined
      ? undefined
      : pauseSeamApproval({
          dispatch: deps.requestApproval,
          adapterOf: deps.channelAdapters,
          observer: deps.observer,
        });
  const runBudgetCap = deps.limits.perRun?.cost ?? Number.POSITIVE_INFINITY;
  return new Map(
    [...agentDefinitions(deps)].map(([name, agent]) => [
      name,
      agentLoopGraph(
        {
          agent,
          bundle: deps.config.name,
          runBudgetCap,
          approval,
          judges: noJudges,
          piiPolicies: deps.piiPolicies?.(name),
          guardrails: deps.guardrails?.(name),
          workflowPiiPolicies: deps.workflowPiiPolicies,
          workflowGuardrails: deps.workflowGuardrails,
          toolPiiPolicies: deps.toolPiiPolicies,
          toolGuardrails: deps.toolGuardrails,
          observer: deps.observer,
        },
        deps.pause?.checkpointer,
      ),
    ]),
  );
}

type Loops = ReturnType<typeof agentLoops>;

function runnerOf(node: RuntimeNode, deps: GraphDeps<string>, loops: Loops): NodeRunner {
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
    case NodeKind.Agent: {
      const loop = loops.get(node.id);
      if (loop === undefined) throw new UnknownAgentError(`Unknown agent: ${node.id}`);
      return agentRunner(node, loop, deps);
    }
    case NodeKind.Workflow:
      throw new TypeError(`${node.id}: child workflows come with #263`);
  }
}

/** Where a node's visit goes: the node it chose, the end, or one `Send` per branch of its launch. */
function nextOf(state: ExecutionStateType): string | Send[] {
  if (state.next === LAUNCH_NEXT)
    return (state.launch?.branches ?? []).map(
      (branch) => new Send(branch.node, branchInputOf(state, branch)),
    );
  return state.next === "" ? END : state.next;
}

/** The limits of one execution: steps, and the run's and the day's money. */
const resolvedLimits = (deps: GraphDeps<string>, run: RunLimits): ResolvedLimits => ({
  steps: deps.maxSteps,
  ...(run.limits.perRun?.cost === undefined ? {} : { runCostUsd: run.limits.perRun.cost }),
  ...(run.limits.perDay?.cost === undefined ? {} : { dayCostUsd: run.limits.perDay.cost }),
});

function compile(deps: GraphDeps<string>, run: RunLimits, checkpointer?: BaseCheckpointSaver) {
  const loops = agentLoops(deps);
  const workflow = { type: deps.graph.type, name: deps.config.name, version: deps.config.version };
  const visitDeps = {
    limits: resolvedLimits(deps, run),
    spentToday: run.spentToday,
    workflow,
    provenance: deps.graph.provenance,
    graph: deps.graph,
    observer: deps.observer,
  };
  const launchDeps = { ...visitDeps, registry: new LaunchRegistry() };
  const nodes = [...deps.graph.nodes.values()];
  // node ids are the components' names, known only at run time: `string`, not literal types
  const graph = new StateGraph<
    typeof ExecutionState.spec,
    ExecutionStateType,
    ExecutionStateUpdate,
    string
  >(ExecutionState);
  for (const node of nodes) {
    const runner = runnerOf(node, deps, loops);
    const isBranch = deps.graph.branchNodes.has(node.id);
    graph.addNode(
      node.id,
      isBranch ? branchNode(node, runner, launchDeps) : visitNode(node, runner, visitDeps),
    );
  }
  for (const launch of deps.graph.launches)
    graph.addNode(launch.joinNodeId, joinNode(launch, launchDeps));
  const ids = [...nodes.map((node) => node.id), ...deps.graph.launches.map((l) => l.joinNodeId)];
  graph.addConditionalEdges(START, (state) => state.start, [...deps.graph.starts]);
  for (const id of ids) graph.addConditionalEdges(id, nextOf, [...ids, END]);
  const recursionLimit = (deps.maxSteps + ids.length) * RECURSION_SAFETY_FACTOR;
  const compiled = graph.compile(checkpointer === undefined ? {} : { checkpointer });
  return compiled.withConfig({ recursionLimit });
}

/** The compiled execution graph of a workflow. */
export type ExecutionGraph = ReturnType<typeof compile>;

/** Builds the workflow's graph for one execution (its limits, its account's spend today). */
export function executionGraphOf(deps: GraphDeps<string>, run: RunLimits): ExecutionGraph {
  return compile(deps, run, deps.pause?.checkpointer);
}
