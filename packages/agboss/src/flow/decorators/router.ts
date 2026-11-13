import { callerFile } from "../../components/call-site.js";
import type { Class, ResolvedAll, Token } from "../../components/injection.js";
import type { UncompactedTurns } from "../../compaction/compaction.decorator.js";
import { NodeKind } from "../ast.js";
import { declared, recordDeclaration, type InputFields } from "./declaration.js";

/** Who decides a router's route (#280): its model, or its class's `route(input)`. */
export enum DecidedBy {
  /** The router's `model` (a decision model like Jev, or a chat model) picks a route. */
  Model = "model",
  /** The class's `route(input)` (`implements RouterHandler<Self>`) picks it: no model call, cost 0. */
  Code = "code",
}

/**
 * Whether a router's target is launched by the framework or chosen by the router (#273, #280):
 * only before `.toParallelAgents(…)`; with `.chooseOne(…)` it fails assembly and every route is a
 * choice. The default per kind: `Always` on a model router's route, `OnDemand` on a code router's.
 */
export enum SpawnPolicy {
  /** Launched by the framework next to the chosen ones; never returned by `route()`. */
  Always = "always",
  /** Launched when the router chooses it. */
  OnDemand = "on-demand",
}

/** What a failed agent of a parallel launch does to the launch (#273): only before `.toParallelAgents(…)`. */
export enum FailurePolicy {
  /** The launch fails (the default, both kinds). */
  FailFast = "fail-fast",
  /** The failed agent drops out of the join; the execution goes on. */
  Skip = "skip",
}

/**
 * A model router's route with its `prompt`: what choosing it means. After `.chooseOne(…)` its model
 * chooses among these; in a launch a route without `spawn` is `Always` (the default) and an
 * explicit `spawn: SpawnPolicy.OnDemand` one is decided by the model.
 */
export interface ChosenRouterRoute {
  /** An agent, an action, another router or a finish — the same targets as `chooseOne(route(…))`. */
  readonly target: Class;
  /** A route to a finish is worded as a stop instruction ("Stop and send the answer: …"). */
  readonly prompt: string;
  readonly spawn?: SpawnPolicy.OnDemand;
  readonly failure?: FailurePolicy;
}

/** A route the framework launches itself (`spawn: SpawnPolicy.Always`): no model sees it. */
export interface AlwaysRouterRoute {
  readonly target: Class;
  readonly spawn: SpawnPolicy.Always;
  readonly failure?: FailurePolicy;
  readonly prompt?: never;
}

/** One route of a model router (`DecidedBy.Model`). */
export type RouterRoute = ChosenRouterRoute | AlwaysRouterRoute;

/** One route of a code router (`DecidedBy.Code`): its `route()` says when; no prompt; `OnDemand` by default. */
export interface CodeRouterRoute {
  readonly target: Class;
  readonly spawn?: SpawnPolicy;
  readonly failure?: FailurePolicy;
  readonly prompt?: never;
}

/**
 * `@Router({ decidedBy: DecidedBy.Model })` — how its model chooses (`prompt`, the route prompts);
 * the flow lists the targets (`.chooseOne(route(…)…)`) and the two lists match (`[router.routes-mismatch]`).
 */
export interface ModelRouterOptions {
  /** Ends with `-router` (`main-router`). */
  readonly name: string;
  readonly description: string;
  /** What it decides on, by type; required and non-empty (`[router.empty-input]`). */
  readonly input: InputFields;
  /** Visits per execution; one more fails before it decides (`VisitsLimitExceededError`). */
  readonly maxVisits?: number;
  readonly decidedBy: DecidedBy.Model;
  readonly routes: readonly [RouterRoute, ...RouterRoute[]];
  /** A decision model (Jev, …) or a chat model; `defaults.router.model` when absent. */
  readonly model?: string;
  /** How to choose: inline, and / or files next to the router (read at assembly). */
  readonly prompt?: string;
  readonly promptUrls?: readonly string[];
  /** Static `{{key}}` values of the prompt. */
  readonly promptVariables?: Readonly<Record<string, string>>;
  readonly deps?: never;
  /** Guardrails added to the inherited ones (`@Application` → `@Workflow`): `@InputGuardrail` / `@OutputGuardrail` classes. */
  readonly guardrails?: readonly Class[];
  /** Inherited guardrails removed for the router's own model. */
  readonly excludeGuardrails?: readonly Class[];
  /** PII policies added to the inherited ones; they apply to its model, never to logs and traces. */
  readonly piiPolicies?: readonly Class[];
  /** Inherited PII policies removed for the router's own model. */
  readonly excludePiiPolicies?: readonly Class[];
  /** Its own `@Compaction`, over the workflow's and the application's. */
  readonly compaction?: Class;
  /** How many recent turns it sees in full, over the workflow's and the application's. */
  readonly uncompactedTurns?: UncompactedTurns;
}

/** `@Router({ decidedBy: DecidedBy.Code })` — the class's `route(input)` chooses; no model, no prompt. */
export interface CodeRouterOptions<TDeps extends readonly Token[] = readonly Token[]> {
  /** Ends with `-router` (`main-router`). */
  readonly name: string;
  readonly description: string;
  /** What it decides on, by type; required and non-empty (`[router.empty-input]`). */
  readonly input: InputFields;
  /** Visits per execution; one more fails before it decides (`VisitsLimitExceededError`). */
  readonly maxVisits?: number;
  readonly decidedBy: DecidedBy.Code;
  readonly routes: readonly [CodeRouterRoute, ...CodeRouterRoute[]];
  /** Constructor dependencies, in order; checked against the constructor by the compiler. */
  readonly deps?: TDeps;
  readonly model?: never;
  readonly prompt?: never;
  readonly promptUrls?: never;
  readonly promptVariables?: never;
  /** A code router reads no thread memory: no compaction, no window. */
  readonly compaction?: never;
  readonly uncompactedTurns?: never;
  /** Guardrails added to the inherited ones (`@Application` → `@Workflow`): `@InputGuardrail` / `@OutputGuardrail` classes. */
  readonly guardrails?: readonly Class[];
  /** Inherited guardrails removed for this router. */
  readonly excludeGuardrails?: readonly Class[];
  /** PII policies added to the inherited ones. */
  readonly piiPolicies?: readonly Class[];
  /** Inherited PII policies removed for this router. */
  readonly excludePiiPolicies?: readonly Class[];
}

/** `@Router` options: a union discriminated by `decidedBy`. */
export type RouterOptions = ModelRouterOptions | CodeRouterOptions;

/** A model router's class has no `route` (a code router's handler): a compile error. */
export type NoRouteMethod<TClass extends Class> =
  InstanceType<TClass> extends { readonly route: unknown }
    ? { readonly __error: "a model router has no route() — routes are chosen by its model" }
    : unknown;

/** What a code router's class has: `route(input)` (`implements RouterHandler<Self>`). */
export interface RouteMethod {
  route(input: never): unknown;
}

/** The decorator of a model router. */
export type ModelRouterDecorator = <TClass extends new () => object>(
  value: TClass & NoRouteMethod<TClass>,
) => TClass;

/** The decorator of a code router: the class implements `route(input)`, its constructor takes `deps`. */
export type CodeRouterDecorator<TDeps extends readonly Token[]> = <
  TClass extends new (...args: ResolvedAll<TDeps>) => RouteMethod,
>(
  value: TClass,
) => TClass;

/** A router its model decides (`DecidedBy.Model`): the class has no `route()`. */
export function Router(options: ModelRouterOptions): ModelRouterDecorator;
/** A router its class decides (`DecidedBy.Code`): `implements RouterHandler<Self>`, `deps` in its constructor. */
export function Router<const TDeps extends readonly Token[] = []>(
  options: CodeRouterOptions<TDeps>,
): CodeRouterDecorator<TDeps>;
export function Router(options: RouterOptions): <TClass extends Class>(value: TClass) => TClass {
  const source = callerFile();
  return <TClass extends Class>(value: TClass): TClass => {
    recordDeclaration(value, declared(NodeKind.Router, options, source));
    return value;
  };
}

/** Whether a router is decided by code. */
export const isCodeRouter = (options: RouterOptions): options is CodeRouterOptions =>
  options.decidedBy === DecidedBy.Code;

/** A route of either kind. */
export type AnyRouterRoute = RouterRoute | CodeRouterRoute;

/** The routes of a router of either kind. */
export const routesOf = (options: RouterOptions): readonly AnyRouterRoute[] => options.routes;

/**
 * A route's spawn policy in a launch (#273, #280): as written, else the kind's default — `Always`
 * for a model router's route, `OnDemand` for a code router's.
 */
export const spawnPolicyOf = (options: RouterOptions, route: AnyRouterRoute): SpawnPolicy =>
  route.spawn ?? (isCodeRouter(options) ? SpawnPolicy.OnDemand : SpawnPolicy.Always);

/** A route's failure policy in a launch: as written, else `FailFast` (both kinds). */
export const failurePolicyOf = (route: AnyRouterRoute): FailurePolicy =>
  route.failure ?? FailurePolicy.FailFast;

/** The routes a launch leaves to the router: its `OnDemand` ones (by the kind's default too). */
export const onDemandRoutesOf = (options: RouterOptions): readonly AnyRouterRoute[] =>
  routesOf(options).filter((route) => spawnPolicyOf(options, route) === SpawnPolicy.OnDemand);
