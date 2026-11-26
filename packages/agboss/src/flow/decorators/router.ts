import { ComponentKind } from "../runtime/records.js";
import { recordOptionKeys } from "../../components/option-keys.js";
import { ROUTER_KEYS } from "../../components/decorator-options.js";
import type { PromptVariables } from "../../components/prompt-variables.js";
import type { PromptSource } from "../../components/prompt-source.js";
import { callerFile } from "../../components/call-site.js";
import { captureCallSite } from "../../core/diagnostics/source-span.js";
import type { Class, ResolvedAll, Token } from "../../components/injection.js";
import { resolveTarget, type TargetRef } from "../target-ref.js";
import type { InputOf, MissingGeneratedTypes } from "../generated-types.js";
import type { RouterHandler } from "../handlers.js";
import { declared, recordDeclaration, type InputFields } from "./declaration.js";

/** Who decides a router's route (#280): its model, or its class's `route(input)`. */
export enum DecidedBy {
  /** The router's `model` (a decision model like Jev, or a chat model) picks a route. */
  Model = "model",
  /** The class's `route(input)` (`implements RouterHandler<Self>`) picks it: no model call, cost 0. */
  Code = "code",
}

/**
 * A model router's route with its `prompt`: what choosing it means. After `.onRoute(…)` its model
 * chooses among these; in `toRouter(R).chooseMany([…])` it picks the ones that run.
 */
export interface ChosenRouterRoute {
  /**
   * An agent, an action, another router or a finish — the same targets as `.onRoute(…)`;
   * `() => Finish` for a class declared below this one (the temporal dead zone, #1271).
   */
  readonly target: TargetRef;
  /** A route to a finish is worded as a stop instruction ("Stop and send the answer: …"). */
  readonly prompt: string;
}

/**
 * `@Router({ decidedBy: DecidedBy.Model })` — how its model chooses (`prompt`, the route prompts);
 * the flow lists the targets (`.onRoute(toAgent(A)…)`) and the two lists match (`[router.routes-mismatch]`).
 */
export interface ModelRouterOptions {
  /** Ends with `-router` (`main-router`). */
  readonly name: string;
  readonly description: string;
  /** What it decides on, by type; required and non-empty (`[router.empty-input]`). */
  readonly input: InputFields;
  /** Visits per execution; one more fails before it decides (`LimitError.Visits`). */
  readonly maxVisits?: number;
  readonly decidedBy: DecidedBy.Model;
  readonly routes: readonly [ChosenRouterRoute, ...ChosenRouterRoute[]];
  /**
   * A decision model or a chat model: a vendor name, or a role of its provider (`"fast"`). Left
   * out: `defaults.router.model`, else the default model of its provider (#1313).
   */
  readonly model?: string;
  /** The `@ModelProvider` class its model is served from; left out: its workflow's, its application's (#1313). */
  readonly modelProvider?: Class;
  /** How to choose: inline, and / or files next to the router (read at assembly). */
  readonly prompt?: PromptSource;
  /** Static `{{key}}` values of the prompt. */
  readonly promptVariables?: PromptVariables;
  readonly deps?: never;
  /** Guardrails added to the inherited ones (`@Application` → `@Workflow`): `@InputGuardrail` / `@OutputGuardrail` classes. */
  readonly guardrails?: readonly Class[];
  /** Inherited guardrails removed for the router's own model. */
  readonly excludeGuardrails?: readonly Class[];
  /** PII policies added to the inherited ones; they apply to its model, never to logs and traces. */
  readonly piiPolicies?: readonly Class[];
  /** Inherited PII policies removed for the router's own model. */
  readonly excludePiiPolicies?: readonly Class[];
  /** Its own `@Memory` class over its workflow's; `NoMemory` sees only the current turn. */
  readonly memory?: Class;
}

/** `@Router({ decidedBy: DecidedBy.Code })` — the class's `route(input)` chooses; no model, no prompt. */
export interface CodeRouterOptions<TDeps extends readonly Token[] = readonly Token[]> {
  /** Ends with `-router` (`main-router`). */
  readonly name: string;
  readonly description: string;
  /** What it decides on, by type; required and non-empty (`[router.empty-input]`). */
  readonly input: InputFields;
  /** Visits per execution; one more fails before it decides (`LimitError.Visits`). */
  readonly maxVisits?: number;
  readonly decidedBy: DecidedBy.Code;
  /** The targets `route()` picks among: a class, or `() => Class` for one declared below (#1279b). */
  readonly routes: readonly [TargetRef, ...TargetRef[]];
  /** Constructor dependencies, in order; checked against the constructor by the compiler. */
  readonly deps?: TDeps;
  readonly model?: never;
  readonly modelProvider?: never;
  readonly prompt?: never;
  readonly promptVariables?: never;
  /** A code router reads no thread memory. */
  readonly memory?: never;
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

/**
 * A code router's `route` is checked against the generated types of its own class (#1279): the
 * parameter `InputOf<Self>`, the return `RouterAnswerOf<Self>` (or its promise) — the contract of
 * `RouterHandler<Self>`. Before `agboss check` has written the types nothing is known to check.
 */
export type RouteChecked<TClass extends Class> =
  InstanceType<TClass> extends infer TSelf
    ? [InputOf<TSelf>] extends [MissingGeneratedTypes]
      ? unknown
      : TSelf extends RouterHandler<TSelf>
        ? unknown
        : {
            readonly __error: "route() must take InputOf<Self> and return RouterAnswerOf<Self> — see RouterHandler<Self>";
          }
    : never;

/** The decorator of a code router: the class implements `route(input)`, its constructor takes `deps`. */
export type CodeRouterDecorator<TDeps extends readonly Token[]> = <
  TClass extends new (...args: ResolvedAll<TDeps>) => RouteMethod,
>(
  value: TClass & RouteChecked<TClass>,
) => TClass;

/** A router its model decides (`DecidedBy.Model`): the class has no `route()`. */
export function Router(options: ModelRouterOptions): ModelRouterDecorator;
/** A router its class decides (`DecidedBy.Code`): `implements RouterHandler<Self>`, `deps` in its constructor. */
export function Router<const TDeps extends readonly Token[] = []>(
  options: CodeRouterOptions<TDeps>,
): CodeRouterDecorator<TDeps>;
export function Router(options: RouterOptions): <TClass extends Class>(value: TClass) => TClass {
  const source = callerFile();
  const span = captureCallSite();
  return <TClass extends Class>(value: TClass): TClass => {
    recordOptionKeys(value, "Router", options, ROUTER_KEYS);
    recordDeclaration(value, declared(ComponentKind.Router, options, source, span));
    return value;
  };
}

/** Whether a router is decided by code. */
export const isCodeRouter = (options: RouterOptions): options is CodeRouterOptions =>
  options.decidedBy === DecidedBy.Code;

/** A route of either kind, its target a class (a `() => Target` thunk resolved). */
export interface AnyRouterRoute {
  readonly target: Class;
  readonly prompt?: string | undefined;
}

/**
 * The routes of a router of either kind, each target resolved to its class (#1271b): read at
 * assembly and run time, once every module has run, never while a decorator is evaluated.
 */
export const routesOf = (options: RouterOptions): readonly AnyRouterRoute[] =>
  options.routes.map((route): AnyRouterRoute => {
    const written = typeof route === "function" ? { target: route } : route;
    return { ...written, target: resolveTarget(written.target) };
  });
