import { extractRunContext } from "../../../core/run-context.js";
import { defaultSummaries } from "../../../graph/agent-definitions.js";
import type { GraphDeps } from "../../../graph/deps.js";
import type { RouteRequest, RouterEngine } from "../../../routers/index.js";
import type { RuntimeNode } from "../graph-model.js";
import { formatMemory } from "../history.js";
import { inputMessageOf } from "../input-message.js";
import type { NodeRunner } from "../node-runner.js";
import { routerFailureOf } from "../router-error.js";
import type { LoadedRouter } from "../routers.js";
import { readInput } from "../scope.js";
import type { ExecutionStateType } from "../state.js";
import { visitNumberOf } from "../step-frame.js";

/** The router's request: its static texts, the thread's memory, then its input message (#270 Q51). */
function requestOf(
  router: LoadedRouter,
  node: RuntimeNode,
  state: ExecutionStateType,
  deps: GraphDeps<string>,
): RouteRequest {
  const memory = formatMemory(state, {
    summaries: defaultSummaries(deps.config),
    turns: deps.config.defaults.history.limit,
  });
  const input = inputMessageOf(node.fields, state);
  return {
    input: memory === "" ? input : `${memory}\n\n${input}`,
    options: router.routes.map((route) => ({ name: route.option, description: route.condition })),
    instructions: router.instructions,
  };
}

/**
 * A model router (`DecidedBy.Model`, #272): its model decides on its `input` only — never the whole
 * path scope — through the decision gateway. A failed model call fails the step with
 * `RouterFailedError` (its cause and spend kept); an answer that is not one of its routes, or not a
 * readable answer, with `RouterDecisionError` — never retried (#280 S19).
 */
export function routerRunner(
  node: RuntimeNode,
  router: LoadedRouter,
  engine: RouterEngine,
  deps: GraphDeps<string>,
): NodeRunner {
  return async (state, config) => {
    const threadId = extractRunContext(config, state.runId).threadId;
    const appState = { runId: state.runId, threadId, activeNode: node.id };
    const request = requestOf(router, node, state, deps);
    const input = typeof request.input === "string" ? request.input : JSON.stringify(request.input);
    await deps.observer?.onRouterStart({ name: node.id, input, state: appState });
    const outcome = await engine.route(request);
    if (outcome.kind === "failed") {
      throw routerFailureOf({ nodeId: node.id, visitNumber: visitNumberOf(node, state) }, outcome);
    }
    const { next, reason } = outcome.decision;
    await deps.observer?.onRouterEnd({
      name: node.id,
      update: { route: next, reason },
      state: appState,
    });
    const usage = outcome.usage === undefined ? [] : [outcome.usage];
    return { route: next, read: readInput(deps.graph, node, state).read, usage };
  };
}
