import type { Class } from "../../components/injection.js";
import { PromptLoader } from "../../components/prompt-render.js";
import type { UsageRecord } from "../../finops/usage.js";
import type { HistoryOf } from "../../flow/dto-wrappers.js";
import {
  routesOf,
  type ModelRouterOptions,
  type RouterOptions,
} from "../../flow/decorators/router.js";
import { declarationOf } from "../../flow/decorators/declaration.js";
import { prettyJson } from "../../flow/runtime/json.js";
import { RouterDecisionError, routerFailureOf } from "../../flow/runtime/router-error.js";
import {
  loadRouter,
  type LoadedRouter,
  type ModelRouterDeclaration,
} from "../../flow/runtime/routers.js";
import {
  flowLaunchDeciderFactory,
  flowRouterFactory,
  type FlowRouterFactoryDeps,
} from "../../graph/router-model.js";
import { DECISION_MODELS } from "../../models/decision-models.js";
import type { UnitSite } from "./unit-site.js";
import { unitRouterDeps } from "./unit-models.js";

/**
 * How a unit runner decides like a router (#262 S89): a code router's answer checked against its
 * routes as its step checks it, a model router's request built as its step builds it — its texts
 * loaded (`prompt`, the route prompts), its input message from the given fields —
 * and answered from the runner's scripts.
 */

const nameOf = (target: Class): string => declarationOf(target)?.options.name ?? target.name;

/** The visit of a unit runner's router: its first. */
const visitOf = (router: string) => ({ nodeId: router, visitNumber: 1 });

/** The targets a launch leaves to the router: all its routes'. */
const routeTargetsOf = (options: RouterOptions): readonly Class[] =>
  routesOf(options).map((route) => route.target);

/**
 * Whether a unit's scripted answers are a launch's: a `decideWith(…)`, or a `routeTo(…)` of none or
 * of several targets — a router unit knows no flow, so the script says whether it chooses one route.
 */
export const isLaunchScript = (model: unknown): boolean =>
  (Array.isArray(model) ? (model as readonly unknown[]) : [model]).some(
    (turn) =>
      typeof turn === "object" &&
      turn !== null &&
      "kind" in turn &&
      (turn.kind === "decide" ||
        (turn.kind === "route" &&
          "targets" in turn &&
          Array.isArray(turn.targets) &&
          turn.targets.length !== 1)),
  );

/** A code router's answer as its step accepts it: one of its routes (`.onRoute(…)`), or a list of them (`chooseMany([…])`). */
export function checkedCodeAnswer(options: RouterOptions, answer: unknown): unknown {
  const step = visitOf(options.name);
  if (Array.isArray(answer)) {
    const allowed = routeTargetsOf(options);
    const outside = (answer as readonly unknown[]).find(
      (target) => !allowed.some((cls) => cls === target),
    );
    if (outside !== undefined)
      throw new RouterDecisionError({
        ...step,
        reason: "route() returned a target outside its routes",
      });
    return answer;
  }
  if (routesOf(options).some((route) => route.target === answer)) return answer;
  throw new RouterDecisionError({
    ...step,
    reason: "route() returned a target outside its routes",
  });
}

/** Who produced a value: its class's `name` (the step reads `{ producer: Class, value }`). */
const producerName = (producer: unknown): string =>
  typeof producer === "function" ? nameOf(producer as Class) : String(producer);

const isProduced = (
  value: unknown,
): value is { readonly producer: unknown; readonly value: unknown } =>
  typeof value === "object" && value !== null && "producer" in value && "value" in value;

/** A list element or an earlier version as the message shows it: `{ producer, value }`, by name. */
const shownOf = (item: unknown): unknown =>
  isProduced(item) ? { producer: producerName(item.producer), value: item.value } : item;

/** One input field's section of the message, as the step writes it (`### field (from producer)`). */
function fieldText(field: string, value: unknown): string {
  if (value === undefined) return `### ${field}\nnone`;
  if (Array.isArray(value)) return `### ${field}\n${prettyJson(value.map(shownOf))}`;
  if (typeof value === "object" && value !== null && "current" in value) {
    const history = value as HistoryOf<unknown>;
    const earlier = prettyJson(history.previous.map(shownOf));
    return `${fieldText(field, history.current)}\n\n### ${field}, earlier versions (oldest first)\n${earlier}`;
  }
  if (isProduced(value))
    return `### ${field} (from ${producerName(value.producer)})\n${prettyJson(value.value)}`;
  return `### ${field}\n${prettyJson(value)}`;
}

/** The router's input message over the given fields, in the order of its `input`. */
const messageOf = (options: RouterOptions, input: unknown): string =>
  Object.keys(options.input)
    .map((field) => fieldText(field, isRecord(input) ? input[field] : undefined))
    .join("\n\n");

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

/** What a model router decided, and what it cost. */
export interface ModelDecision {
  readonly answer: Class | readonly Class[];
  readonly usage: readonly UsageRecord[];
}

/** The router's routes by the name its model answers with. */
const targetNamed = (options: RouterOptions, name: string): Class | undefined =>
  routesOf(options).find((route) => nameOf(route.target) === name)?.target;

/** What a model router decides from: its texts loaded, its input message, its models. */
interface DecisionSite {
  readonly options: ModelRouterOptions;
  readonly router: LoadedRouter;
  readonly message: string;
  readonly deps: FlowRouterFactoryDeps;
}

const usageOf = (usage: UsageRecord | undefined): readonly UsageRecord[] =>
  usage === undefined ? [] : [usage];

/** In a `chooseMany([…])` launch: its routes, one yes/no each. */
async function launchDecision(site: DecisionSite): Promise<ModelDecision> {
  const { options, router } = site;
  const questions = routeTargetsOf(options).map((target) => ({
    target: nameOf(target),
    prompt: router.routes.find((route) => route.option === nameOf(target))?.condition ?? "",
  }));
  const request = { input: site.message, instructions: router.instructions, questions };
  const outcome = await flowLaunchDeciderFactory(site.deps)(router).decide(request);
  if (outcome.kind === "failed") throw routerFailureOf(visitOf(options.name), outcome);
  const launched = outcome.launched.flatMap((name) => targetNamed(options, name) ?? []);
  return { answer: launched, usage: usageOf(outcome.usage) };
}

/** After `.onRoute(…)`: one of its routes. */
async function routeDecision(site: DecisionSite): Promise<ModelDecision> {
  const { options, router } = site;
  const step = visitOf(options.name);
  const choices = router.routes.map((route) => ({
    name: route.option,
    description: route.condition,
  }));
  const request = { input: site.message, options: choices, instructions: router.instructions };
  const outcome = await flowRouterFactory(site.deps)(router).route(request);
  if (outcome.kind === "failed") throw routerFailureOf(step, outcome);
  const target = targetNamed(options, outcome.decision.next);
  if (target === undefined)
    throw new RouterDecisionError({
      ...step,
      reason: `"${outcome.decision.next}" is not one of its routes`,
    });
  return { answer: target, usage: usageOf(outcome.usage) };
}

/**
 * A model router's decision on the runner's scripts: one route after `.onRoute(…)`
 * (`routeTo(X)`), the routes of a `chooseMany([…])` launch when `isLaunch` (`decideWith({ "<target>":
 * 0.9 })`, or `routeTo(…)` of none or several). A router without its own model decides on a decision model, as
 * `defaults.router.model` (Jev) does.
 */
export async function modelDecision(
  site: UnitSite,
  declaration: ModelRouterDeclaration,
  input: unknown,
  isLaunch: boolean,
): Promise<ModelDecision> {
  const { options } = declaration;
  const loader = new PromptLoader();
  const router = await loadRouter(options.name, declaration, loader, DECISION_MODELS[0]);
  loader.throwIfAny();
  const decision = { options, router, message: messageOf(options, input) };
  const deps = unitRouterDeps(site.gateway);
  return isLaunch ? launchDecision({ ...decision, deps }) : routeDecision({ ...decision, deps });
}
