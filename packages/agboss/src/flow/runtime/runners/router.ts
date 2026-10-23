import type { GraphDeps } from "../../../graph/deps.js";
import type { RouteRequest, RouterEngine } from "../../../routers/index.js";
import type { RuntimeNode } from "../graph-model.js";
import { formatMemory, readerMemoryOf } from "../history.js";
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
import { GuardrailSide } from "../../../components/policy-decorators.js";
import { type GuardrailsPassed, runGuardrails } from "../../../guardrails/runtime.js";
import type { UsageRecord } from "../../../finops/usage.js";
import type { PiiPolicySet } from "../../../pii/policy-set.js";
import type { PiiTokenMap } from "../../../pii/tokens.js";
import { RecursionDecider } from "../../analyse/recursion.js";
import { unreadyRoutesOf } from "../soft-stop.js";

/** What the router's model reads, masked — and of it the input message (what its guardrails check). */
interface MaskedRouterInput extends MaskedModelText {
  readonly input: string;
}

/** Texts through the router's PII policies, one after another: new tokens known to the next. */
async function maskedTexts(
  set: PiiPolicySet,
  texts: readonly string[],
  known: PiiTokenMap,
): Promise<{ readonly texts: readonly string[]; readonly masked: MaskedModelText }> {
  const tokens: Record<string, string> = {};
  const usage: UsageRecord[] = [];
  const masked: string[] = [];
  for (const text of texts) {
    const one = await maskedModelText(set, text, { ...known, ...tokens });
    Object.assign(tokens, one.tokens);
    usage.push(...one.usage);
    masked.push(one.text);
  }
  return { texts: masked, masked: { text: masked.join("\n\n"), tokens, usage } };
}

/**
 * What the router's model reads besides its static texts: the thread's memory, then its input
 * message (#270 Q51) — through its PII policies (#120: `sensitive` fields, the rules, the
 * execution's sensitive context values; a block rule refuses). With input guardrails the memory and
 * the input message are masked apart, so the guardrails read the input message as the model does.
 */
async function maskedInputOf(
  node: RuntimeNode,
  state: ExecutionStateType,
  deps: GraphDeps<string>,
  isGuarded: boolean,
): Promise<MaskedRouterInput> {
  const view = readerMemoryOf(state, node.id);
  const memory = formatMemory(view, {
    summaries: view.summaries.length,
    turns: view.history.length,
  });
  const boundary = boundaryInputOf(node, state, deps.pii);
  const parts = memory === "" ? [boundary.input] : [memory, boundary.input];
  if (deps.pii === undefined)
    return { text: parts.join("\n\n"), input: boundary.input, tokens: {}, usage: [] };
  const set = deps.pii
    .policiesOf(node.id)
    .withValues(boundary.pii.values)
    .withFieldKey(boundary.pii.key);
  const known = { ...state.piiTokens, ...boundary.pii.tokens };
  const { texts, masked } = await maskedTexts(set, isGuarded ? parts : [parts.join("\n\n")], known);
  const input = isGuarded ? (texts[texts.length - 1] ?? "") : masked.text;
  return { ...masked, input, tokens: { ...boundary.pii.tokens, ...masked.tokens } };
}

/** The router's input guardrails (#120) on its masked input message: their spend and decisions. */
function guardedInput(
  node: RuntimeNode,
  masked: MaskedRouterInput,
  deps: GraphDeps<string>,
): Promise<GuardrailsPassed> {
  const guardrails = deps.guardrails?.inputOf(node.id) ?? [];
  if (guardrails.length === 0) return Promise.resolve({ usage: [], decisions: [] });
  const checked = { text: masked.input, element: node.id, side: GuardrailSide.Input };
  return runGuardrails(guardrails, checked, deps.observer);
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
    const isGuarded = (deps.guardrails?.inputOf(node.id) ?? []).length > 0;
    const masked = await maskedInputOf(node, state, deps, isGuarded);
    const { usage: guarded, decisions: guardrailDecisions } = await guardedInput(
      node,
      masked,
      deps,
    );
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
      const usage = [...masked.usage, ...guarded, ...launch.usage];
      return { launch: launch.launch, read, usage, piiTokens, guardrailDecisions };
    }
    const outcome = await engine.route(shownRequest(node, request, deps));
    if (outcome.kind === "failed")
      throw routerFailureOf(step, outcome, [...masked.usage, ...guarded]);
    const { next, reason } = outcome.decision;
    const update = { route: next, reason };
    await reportNodeEvent((base) => deps.observer?.onRouterEnd({ ...base, name, update }));
    const usage = [
      ...masked.usage,
      ...guarded,
      ...(outcome.usage === undefined ? [] : [outcome.usage]),
    ];
    return { route: next, read, usage, piiTokens, guardrailDecisions };
  };
}
