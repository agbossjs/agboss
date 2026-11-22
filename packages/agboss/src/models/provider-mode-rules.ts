import { MAX_TIMEOUT, timerProblemOf } from "../units/timer-limits.js";
import type { Provider } from "../components/injection.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import {
  circuitBreakerPolicyOf,
  hasProviderMethod,
  isModelProviderClass,
  isTransportClass,
  modelProviderOf,
  type ModelProviderType,
} from "./model-provider.decorator.js";
import { modelPricesProblemOf } from "./cost.js";
import { withFallbacks } from "./resolution.js";

/**
 * A `@ModelProvider` is either HTTP — `baseUrl` (and `apiKey`, `baseUrlField`), a `chat` /
 * `routeTo` class — or a transport (#385): `complete(request)`, `deps`, no base URL or key. Both at
 * once, or neither, is `[model-provider.both-modes]` (the decorator's overloads make it a compile
 * error too).
 */

const HTTP_FIELDS = ["baseUrl", "baseUrlField", "apiKey"] as const;

/** The HTTP fields the decorator sets. */
const httpFieldsOf = (cls: ModelProviderType): readonly string[] =>
  HTTP_FIELDS.filter((field) => Reflect.get(modelProviderOf(cls), field) !== undefined);

/** What is wrong with a provider's mode, if anything. */
function modeProblemOf(cls: ModelProviderType): string | undefined {
  const fields = httpFieldsOf(cls);
  const isTransport = isTransportClass(cls);
  if (isTransport && fields.length > 0)
    return `implements complete(request) and sets ${fields.join(", ")} — a transport makes its own calls: remove them`;
  if (isTransport && hasProviderMethod(cls, "chat"))
    return "has both chat(request) and complete(request) — keep one: HTTP (chat) or a transport (complete)";
  const deps = modelProviderOf(cls).deps ?? [];
  if (!isTransport && deps.length > 0)
    return "has deps but no complete(request) — only a transport provider is created by the container";
  if (!isTransport && fields.length === 0)
    return "has neither a baseUrl (HTTP) nor complete(request) (a transport)";
  return undefined;
}

/** `[model-provider.both-modes]` for every listed model provider and breaker fallback in no single mode. */
export function providerModeViolations(
  application: string,
  providers: readonly Provider[] | undefined,
): RuleViolation[] {
  const classes = withFallbacks((providers ?? []).filter(isModelProviderClass));
  return classes.flatMap((cls) => {
    const problem = modeProblemOf(cls);
    if (problem === undefined) return [];
    const message = `${modelProviderOf(cls).name} (${cls.name}) ${problem}`;
    return [violation("model-provider.both-modes", message, [application])];
  });
}

/**
 * `[model-provider.circuit-breaker-required]` for every listed model provider and breaker fallback
 * without `circuitBreakerPolicy` (#521): the type requires it, a JS project or a cast can leave it
 * out — named at assembly, never a crash on its first read.
 */
export function providerBreakerViolations(
  application: string,
  providers: readonly Provider[] | undefined,
): RuleViolation[] {
  const classes = withFallbacks((providers ?? []).filter(isModelProviderClass));
  return classes
    .filter((cls) => circuitBreakerPolicyOf(modelProviderOf(cls)) === undefined)
    .map((cls) => {
      const message =
        `${modelProviderOf(cls).name} (${cls.name}) has no circuitBreakerPolicy — set ` +
        "circuitBreakerPolicy: { failureThreshold, window, openFor } on its @ModelProvider";
      return violation("model-provider.circuit-breaker-required", message, [application]);
    });
}

/** Whether an HTTP provider's instance is an OpenAI-compatible one whose class sets no `requestFields`. */
function lacksRequestFields(cls: ModelProviderType): boolean {
  if (isTransportClass(cls)) return false;
  // an HTTP @ModelProvider class takes no arguments (the decorator's overload requires it)
  const instance: object = Reflect.construct(cls, []) as object;
  if (typeof Reflect.get(instance, "wirePlanOf") !== "function") return false;
  const fields: unknown = Reflect.get(instance, "requestFields");
  return typeof fields !== "object" || fields === null;
}

/**
 * `[model-provider.request-fields-missing]` (#644) for every listed OpenAI-compatible provider whose
 * class sets no `requestFields`: the type requires it (`abstract`), a JS project or a run before
 * `tsc` can leave it out — named at assembly and by `agboss check`, never a `TypeError` at the first
 * model call.
 */
export function providerFieldsViolations(
  application: string,
  providers: readonly Provider[] | undefined,
): RuleViolation[] {
  const classes = withFallbacks((providers ?? []).filter(isModelProviderClass));
  return classes.filter(lacksRequestFields).map((cls) => {
    const message =
      `${modelProviderOf(cls).name} (${cls.name}) sets no requestFields — an OpenAI-compatible ` +
      "provider says which request fields it sends: override readonly requestFields = {} (none)";
    return violation("model-provider.request-fields-missing", message, [application]);
  });
}

/**
 * `[limits.timeout-invalid]` (#1141) for every listed model provider and breaker fallback whose
 * `timeout` is above its maximum: a call's timer would fire at once.
 */
export function providerTimeoutViolations(
  application: string,
  providers: readonly Provider[] | undefined,
): RuleViolation[] {
  const classes = withFallbacks((providers ?? []).filter(isModelProviderClass));
  return classes.flatMap((cls) => {
    const { name, timeout } = modelProviderOf(cls);
    const problem = timerProblemOf("timeout", timeout, MAX_TIMEOUT);
    return problem === undefined
      ? []
      : [violation("limits.timeout-invalid", `${name} (${cls.name}): ${problem}`, [application])];
  });
}

/**
 * `[model.price-invalid]` (#1385) for every listed model provider and breaker fallback whose `from-prices`
 * table holds a price that is no finite number of dollars from 0: `ModelCost` is a public union, so a literal
 * never passes `ModelCost.fromPrices`. Names the provider, the field and the value's kind, never a model.
 */
export function providerPriceViolations(
  application: string,
  providers: readonly Provider[] | undefined,
): RuleViolation[] {
  const classes = withFallbacks((providers ?? []).filter(isModelProviderClass));
  return classes.flatMap((cls) => {
    const { name, cost } = modelProviderOf(cls);
    const problem = cost.kind === "from-prices" ? modelPricesProblemOf(cost.prices) : undefined;
    return problem === undefined
      ? []
      : [violation("model.price-invalid", `${name} (${cls.name}): ${problem}`, [application])];
  });
}
