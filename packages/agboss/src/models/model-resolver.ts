import type { Class } from "../components/injection.js";
import { GraphRuleError, violation, type RuleViolation } from "../graph/rule-error.js";
import {
  levelModelOf,
  modelNamedBy,
  overlaidProvider,
  providerOptionsOf,
  referencedModelProvidersOf,
  type ModelCascade,
} from "./model-cascade.js";
import { modelProviderOf, type KeptModelProviderOptions } from "./model-provider.decorator.js";

/**
 * The resolver of a workflow's model cascade (#1313): every model-backed component's model, through
 * its own provider, its workflow's, its application's, and the default model of the levels.
 */

/** What a component sets itself: its own `modelProvider` class, and whether it names no model. */
export interface OwnModel {
  readonly provider?: Class | undefined;
  readonly isOmitted?: boolean;
  /**
   * The component has no model of its own elsewhere (no `defaults.router` / `defaults.guardrail`):
   * naming none with no provider in the cascade is `[model.missing-provider]`.
   */
  readonly isRequired?: boolean;
}

/** A model use as the resolver reads and gives it back. */
export interface ModelUseLike {
  readonly model: string;
  readonly modelProvider?: string | undefined;
  readonly unpriced?: true | undefined;
}

/** What the cascade's own levels and the components' own providers found wrong, all at once. */
export interface ModelResolver {
  readonly violations: RuleViolation[];
  /**
   * A model use with its provider and model name resolved; unchanged when no provider is in its
   * cascade. `isOmitted`: the component names no model, so the default levels apply.
   */
  readonly use: <T extends ModelUseLike>(use: T, key: string, own?: OwnModel) => T;
  /** Whether the workflow or its application sets a `modelProvider`: a component naming no model is then served. */
  readonly isInherited: boolean;
  /** The `@ModelProvider` classes every use resolved through so far, each once. */
  readonly providers: () => readonly Class[];
  /** Throws the violations found, if any. */
  readonly check: () => void;
}

/** What a resolver works on. */
interface ResolverState {
  readonly workflow: string;
  readonly cascade: ModelCascade;
  readonly byName: ReadonlyMap<string, Class>;
  readonly violations: RuleViolation[];
  readonly reached: Set<Class>;
}

const inheritedOf = (cascade: ModelCascade): Class | undefined =>
  cascade.workflow ?? cascade.application;

/** The provider class a use goes to: its component's own, the one its config names, else the cascade's. */
const providerClassOf = (state: ResolverState, named: ModelUseLike, own: OwnModel) =>
  own.provider ??
  (named.modelProvider === undefined
    ? inheritedOf(state.cascade)
    : state.byName.get(named.modelProvider));

/** The model a provider serves for what a use asked, or `[model.missing]`; `undefined` for none. */
function modelOf(
  state: ResolverState,
  options: KeptModelProviderOptions,
  cls: Class,
  asked: { readonly model: string; readonly isOmitted: boolean; readonly key: string },
): string | undefined {
  const requested = asked.isOmitted ? levelModelOf(state.cascade, cls) : asked.model;
  const model = modelNamedBy(options, requested);
  if (model === undefined)
    state.violations.push(
      violation(
        "model.missing",
        `${state.workflow} ${asked.key}: names no model and ${options.name} has no model or models.default — set model on the component or on the provider`,
        [state.workflow],
      ),
    );
  return model;
}

/** One use through the cascade. */
function resolvedUse<T extends ModelUseLike>(
  state: ResolverState,
  named: T,
  key: string,
  own: OwnModel,
): T {
  const cls = providerClassOf(state, named, own);
  const isOmitted = own.isOmitted === true;
  if (cls === undefined) {
    if (isOmitted && own.isRequired === true)
      state.violations.push(
        violation(
          "model.missing-provider",
          `${state.workflow} ${key}: names no model and no modelProvider is set — name a model, or set modelProvider on the component, its @Workflow or its @Application`,
          [state.workflow],
        ),
      );
    return named;
  }
  const declared = providerOptionsOf(cls);
  if (declared === undefined) return named;
  const options = overlaidProvider(declared, state.cascade.providerOverlays?.[declared.name]);
  state.reached.add(cls);
  const model = modelOf(state, options, cls, { model: named.model, isOmitted, key });
  if (model === undefined) return named;
  return {
    ...named,
    model,
    modelProvider: options.name,
    ...(options.cost === undefined ? { unpriced: true as const } : {}),
  };
}

/** The resolver of one workflow's cascade: its violations are collected, then thrown by `check`. */
export function modelResolverOf(
  workflow: string,
  cascade: ModelCascade,
  extra: readonly RuleViolation[] = [],
): ModelResolver {
  const state: ResolverState = {
    workflow,
    cascade,
    byName: new Map(
      referencedModelProvidersOf(cascade).map((cls) => [modelProviderOf(cls).name, cls]),
    ),
    violations: [...extra],
    reached: new Set(),
  };
  return {
    violations: state.violations,
    use: (named, key, own = {}) => resolvedUse(state, named, key, own),
    isInherited: inheritedOf(cascade) !== undefined,
    providers: () => [...state.reached],
    check: () => {
      if (state.violations.length > 0) throw new GraphRuleError({ violations: state.violations });
    },
  };
}

/** What a component's model resolves to, to spread into its record: the model, its provider, its price mark. */
export interface ResolvedComponentModel {
  readonly model: string;
  readonly modelProvider?: string;
  readonly unpriced?: true;
}

/**
 * A component's model through the cascade: `model`, else `fallback` (what an older default names:
 * `defaults.router.model`), else the default of its levels and its provider. Without a resolver (a
 * unit, a profile) or a provider in the cascade it is what was written (`""` for none).
 */
export function componentModelOf(
  resolver: ModelResolver | undefined,
  key: string,
  own: {
    readonly model?: string | undefined;
    readonly fallback?: string | undefined;
    readonly provider?: Class | undefined;
    readonly isRequired?: boolean;
  },
): ResolvedComponentModel {
  const named = own.model ?? own.fallback;
  const written: ResolvedComponentModel = { model: named ?? "" };
  const { model, modelProvider, unpriced } =
    resolver?.use(written, key, {
      provider: own.provider,
      isOmitted: named === undefined,
      ...(own.isRequired === true ? { isRequired: true } : {}),
    }) ?? written;
  return {
    model,
    ...(modelProvider === undefined ? {} : { modelProvider }),
    ...(unpriced === undefined ? {} : { unpriced }),
  };
}
