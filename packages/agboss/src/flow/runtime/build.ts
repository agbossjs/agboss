import { END, Send, START, StateGraph, type BaseCheckpointSaver } from "@langchain/langgraph";
import { agentDefinitions } from "../../graph/agent-definitions.js";
import { agentLoopGraph, noJudges, pauseSeamApproval } from "../../graph/agent-loop/index.js";
import type { GraphDeps } from "../../graph/deps.js";
import type { Class } from "../../components/injection.js";
import type { BudgetMeter } from "../../budgets/execution-budgets.js";
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
import { visitNode } from "./visit.js";
import { standaloneContexts } from "../context/runtime-contexts.js";

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

/** Every agent's loop, compiled once per graph (approval only with a pause seam). */
function agentLoops(deps: GraphDeps<string>, run: RunLimits) {
  const approval =
    deps.pause === undefined
      ? undefined
      : pauseSeamApproval({
          dispatch: deps.requestApproval,
          adapterOf: deps.channelAdapters,
          observer: deps.observer,
        });
  return new Map(
    [...agentDefinitions(deps)].map(([name, agent]) => [
      name,
      agentLoopGraph(
        {
          agent,
          bundle: deps.config.name,
          budgets: run.budgets,
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

function compile(deps: GraphDeps<string>, run: RunLimits, checkpointer?: BaseCheckpointSaver) {
  const loops = agentLoops(deps, run);
  const workflow = { type: deps.graph.type, name: deps.config.name, version: deps.config.version };
  const visitDeps = {
    limits: { maxSteps: deps.maxSteps, budgets: run.budgets },
    workflow,
    contexts: deps.contexts ?? standaloneContexts(workflow),
    provenance: deps.graph.provenance,
    graph: deps.graph,
    observer: deps.observer,
  };
  const launchDeps = {
    ...visitDeps,
    registry: new LaunchRegistry(),
    // a quorum's arbiters (#279): code ones from the container, model ones on their model
    arbiters: {
      instanceOf: (arbiter: Class): unknown => deps.container.get(arbiter),
      ...(deps.arbiterModelFor === undefined ? {} : { modelOf: deps.arbiterModelFor }),
    },
    ...(checkpointer === undefined ? {} : { checkpointer }),
  };
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

/** Builds the workflow's graph for one pass of an execution (its budgets). */
export function executionGraphOf(deps: GraphDeps<string>, run: RunLimits): ExecutionGraph {
  return compile(deps, run, deps.pause?.checkpointer);
}
