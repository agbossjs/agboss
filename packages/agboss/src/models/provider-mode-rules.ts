import { MAX_TIMEOUT, timerProblemOf } from "../units/timer-limits.js";
import type { Provider } from "../components/injection.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import {
  fallbackOf,
  isDriverOptions,
  isModelProviderClass,
  isTransportClass,
  modelProviderOf,
  type ModelProviderType,
} from "./model-provider.decorator.js";
import { modelPricesProblemOf } from "./cost.js";
import { fallbackCycleOf } from "./fallback-chain.js";
import { listedModelProvidersOf, withFallbacks } from "./resolution.js";
import { tokenName } from "../components/injection.js";

/**
 * A `@ModelProvider` is either a driver — `driver`, an empty class — or a transport (#385):
 * `complete(request)` and its `deps`. Both at once, or neither, is `[model-provider.both-modes]`
 * (the decorator's overloads make it a compile error too).
 */

/** A driver provider speaks its driver's protocol: its class is empty (#1313). */
const driverModeProblemOf = (cls: ModelProviderType): string | undefined =>
  isTransportClass(cls)
    ? "sets a driver and implements complete(request) — the driver makes its calls: remove the method"
    : undefined;

/** What is wrong with a provider's mode, if anything. */
function modeProblemOf(cls: ModelProviderType): string | undefined {
  return isDriverOptions(modelProviderOf(cls)) ? driverModeProblemOf(cls) : ownModeProblemOf(cls);
}

/** What is wrong with a transport provider's mode, if anything. */
function ownModeProblemOf(cls: ModelProviderType): string | undefined {
  const isTransport = isTransportClass(cls);
  const deps = modelProviderOf(cls).deps ?? [];
  if (!isTransport && deps.length > 0)
    return "has deps but no complete(request) — only a transport provider is created by the container";
  if (!isTransport) return "has neither a driver nor complete(request) (a transport)";
  return undefined;
}

/** `[model-provider.both-modes]` for every listed model provider and breaker fallback in no single mode. */
export function providerModeViolations(
  application: string,
  providers: readonly Provider[] | undefined,
): RuleViolation[] {
  const classes = withFallbacks(listedModelProvidersOf(providers));
  return classes.flatMap((cls) => {
    const problem = modeProblemOf(cls);
    if (problem === undefined) return [];
    const message = `${modelProviderOf(cls).name} (${cls.name}) ${problem}`;
    return [violation("model-provider.both-modes", message, [application])];
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
  const classes = withFallbacks(listedModelProvidersOf(providers));
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
  const classes = withFallbacks(listedModelProvidersOf(providers));
  return classes.flatMap((cls) => {
    const { name, cost } = modelProviderOf(cls);
    const problem = cost?.kind === "from-prices" ? modelPricesProblemOf(cost.prices) : undefined;
    return problem === undefined
      ? []
      : [violation("model.price-invalid", `${name} (${cls.name}): ${problem}`, [application])];
  });
}

/**
 * `[model-provider.fallback-cycle]` for a provider whose fallback chain returns to a provider it has
 * passed (`A → B → A`), and `[model.incompatible-fallback-provider]` for a fallback of the other kind:
 * a chat provider falls back to a chat provider, a decisions provider to a decisions one.
 */
export function providerFallbackViolations(
  scope: string,
  providers: readonly Provider[] | undefined,
): RuleViolation[] {
  const classes = withFallbacks(listedModelProvidersOf(providers));
  return classes.flatMap((cls) => {
    const options = modelProviderOf(cls);
    const next = fallbackOf(options)?.provider;
    if (next === undefined) return [];
    if (!isModelProviderClass(next)) {
      const message = `${options.name} (${cls.name}) names a fallback that is no @ModelProvider class`;
      return [violation("model-provider.fallback-cycle", message, [scope])];
    }
    const found = fallbackCycleOf(cls);
    const cycle =
      found?.[0] === cls
        ? [
            violation(
              "model-provider.fallback-cycle",
              `${options.name} (${cls.name}): its fallback chain comes back to ${modelProviderOf(found.at(-1) ?? cls).name}`,
              [scope],
            ),
          ]
        : [];
    const backup = modelProviderOf(next);
    const kind = (candidate: typeof options): string | undefined =>
      isDriverOptions(candidate) ? candidate.driver.kind : undefined;
    const [own, other] = [kind(options), kind(backup)];
    const mismatch =
      own !== undefined && other !== undefined && own !== other
        ? [
            violation(
              "model.incompatible-fallback-provider",
              `${options.name} (${cls.name}) is a ${own} provider and falls back to ${backup.name} (${next.name}), a ${other} one`,
              [scope],
            ),
          ]
        : [];
    return [...cycle, ...mismatch];
  });
}

/**
 * `[model.duplicate-provider-name]` (bughunt 2026-11-25 #1): two `@ModelProvider` classes of one `name`
 * among the providers a place reaches — listed, named by a cascade level or a component, a profile's
 * slot, a breaker's fallback. A model use is resolved to its provider's `name`, so the second class's
 * calls would go to the first one's upstream with the first one's key and be accounted under it.
 */
export function providerNameViolations(
  scope: string,
  providers: readonly Provider[] | undefined,
): RuleViolation[] {
  const byName = new Map<string, ModelProviderType[]>();
  for (const cls of withFallbacks(listedModelProvidersOf(providers))) {
    const { name } = modelProviderOf(cls);
    byName.set(name, [...(byName.get(name) ?? []), cls]);
  }
  return [...byName].flatMap(([name, classes]) =>
    classes.length < 2
      ? []
      : [
          violation(
            "model.duplicate-provider-name",
            `${name} names ${classes.map(tokenName).join(" and ")} — each @ModelProvider needs its own name`,
            [scope],
          ),
        ],
  );
}

/**
 * Every provider rule over the providers a place names (#1313): mode, timeout
 * and price. The application runs it over its listed providers and its own `modelProvider`; a workflow's
 * assembly runs it over every provider its cascade names (the workflow's, its agents', its components'),
 * so a provider named only there is checked exactly like a listed one.
 */
export function providerRuleViolations(
  scope: string,
  providers: readonly Provider[] | undefined,
): RuleViolation[] {
  return [
    ...providerModeViolations(scope, providers),
    ...providerTimeoutViolations(scope, providers),
    ...providerPriceViolations(scope, providers),
    ...providerFallbackViolations(scope, providers),
  ];
}
