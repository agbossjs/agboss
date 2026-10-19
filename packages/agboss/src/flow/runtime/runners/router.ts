import { defaultSummaries } from "../../../graph/agent-definitions.js";
import type { GraphDeps } from "../../../graph/deps.js";
import type { RouteRequest, RouterEngine } from "../../../routers/index.js";
import type { RuntimeNode } from "../graph-model.js";
import { formatMemory } from "../history.js";
import type { NodeRunner } from "../node-runner.js";
import { routerFailureOf } from "../router-error.js";
import type { LoadedRouter } from "../routers.js";
import { readInput } from "../scope.js";
import type { ExecutionStateType } from "../state.js";
import { visitNumberOf } from "../step-frame.js";
import { modelRouterLaunch } from "../launch/router-decision.js";
import { reportNodeEvent } from "../../observers/execution-event.js";
import { maskedModelText, type MaskedModelText } from "../../../pii/model-boundary.js";
import { boundaryInputOf } from "./boundary-input.js";
import { RecursionDecider } from "../../analyse/recursion.js";
import { unreadyRoutesOf } from "../soft-stop.js";

/**
 * What the router's model reads besides its static texts: the thread's memory, then its input
 * message (#270 Q51) — through its PII policies (#120: `sensitive` fields, the rules, the
 * execution's sensitive context values; a block rule refuses).
 */
async function maskedInputOf(
  node: RuntimeNode,
  state: ExecutionStateType,
  deps: GraphDeps<string>,
): Promise<MaskedModelText> {
  const memory = formatMemory(state, {
    summaries: defaultSummaries(deps.config),
    turns: deps.config.defaults.history.limit,
  });
  const boundary = boundaryInputOf(node, state, deps.pii);
  const input = memory === "" ? boundary.input : `${memory}\n\n${boundary.input}`;
  if (deps.pii === undefined) return { text: input, tokens: {}, usage: [] };
  const set = deps.pii.policiesOf(node.id).withValues(boundary.pii.values);
  const masked = await maskedModelText(set, input, { ...state.piiTokens, ...boundary.pii.tokens });
  return { ...masked, tokens: { ...boundary.pii.tokens, ...masked.tokens } };
}

/** The router's request: its options and instructions over its masked input. */
const requestOf = (router: LoadedRouter, input: string): RouteRequest => ({
  input,
  options: router.routes.map((route) => ({ name: route.option, description: route.condition })),
  instructions: router.instructions,
});

/** The request as the model sees it: on the last level, without the recursive routes (#264). */
function shownRequest(
  node: RuntimeNode,
  request: RouteRequest,
  deps: GraphDeps<string>,
): RouteRequest {
  const hidden = unreadyRoutesOf(deps.graph, node.id, RecursionDecider.ModelRouter);
  if (hidden.length === 0) return request;
  const options = request.options.filter((option) => !hidden.includes(option.name));
  return { ...request, options };
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
    const name = node.id;
    const masked = await maskedInputOf(node, state, deps);
    const request = requestOf(router, masked.text);
    const input = masked.text;
    const piiTokens = masked.tokens;
    await reportNodeEvent((base) => deps.observer?.onRouterStart({ ...base, name, input }));
    const step = { nodeId: node.id, visitNumber: visitNumberOf(node, state) };
    const read = readInput(deps.graph, node, state).read;
    if (node.exits.launches.size > 0) {
      const decider = deps.launchDecisionFor?.(router);
      const launch = await modelRouterLaunch({ node, router, step, input, decider, ...{ config } });
      const update = { route: launch.launch.join(", "), reason: launch.reason };
      await reportNodeEvent((base) => deps.observer?.onRouterEnd({ ...base, name, update }));
      return { launch: launch.launch, read, usage: [...masked.usage, ...launch.usage], piiTokens };
    }
    const outcome = await engine.route(shownRequest(node, request, deps));
    if (outcome.kind === "failed") throw routerFailureOf(step, outcome, masked.usage);
    const { next, reason } = outcome.decision;
    const update = { route: next, reason };
    await reportNodeEvent((base) => deps.observer?.onRouterEnd({ ...base, name, update }));
    const usage = [...masked.usage, ...(outcome.usage === undefined ? [] : [outcome.usage])];
    return { route: next, read, usage, piiTokens };
  };
}
