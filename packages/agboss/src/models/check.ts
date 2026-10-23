import type { Environment } from "../flow/generated-types.js";
import { NO_ENVIRONMENT_VALUES } from "../environments/resolve.js";
import { connectionOf } from "./connections.js";
import { priceOf } from "./cost.js";
import { fallbackProblems } from "./fallback-check.js";
import type { ModelProviderHandler, ProviderConnection } from "./handler.js";
import { hasProviderMethod, type ModelProviderType } from "./model-provider.decorator.js";
import type { ModelProblem } from "./problems.js";
import type { ModelProviderDirectory, RegisteredModelProvider } from "./resolve.js";
import type { ProviderFetch } from "./resilient-fetch.js";
import { settingProblems } from "./setting-problems.js";
import type { ModelUse } from "./uses.js";

/** How the check reaches the providers' model lists (no key needed, no rate limit, no breaker). */
export interface ModelCheckOptions {
  readonly env: NodeJS.ProcessEnv;
  /** The application's environment: a key it holds is sent; a missing one is not a problem. */
  readonly environment?: Environment;
  readonly send?: ProviderFetch;
  /**
   * A transport provider's instance (#385: the application's container); absent — `agboss check
   * --models` — a transport's capabilities are not checked.
   */
  readonly transports?: (cls: ModelProviderType) => ModelProviderHandler;
}

/**
 * Problems found without asking any provider: a model nobody serves, or several do; a provider
 * with a fallback that has no model for it, or no price for that model (#202).
 */
export function resolutionProblems(
  uses: readonly ModelUse[],
  directory: ModelProviderDirectory,
): readonly ModelProblem[] {
  return uses.flatMap((use) => {
    const resolution = directory.resolve(use);
    return resolution.kind === "problem"
      ? [resolution.problem]
      : fallbackProblems(use, resolution.provider.options);
  });
}

function priceProblems(use: ModelUse, provider: RegisteredModelProvider): readonly ModelProblem[] {
  const cost = provider.options.cost;
  if (cost.kind === "from-response" || use.settings === undefined) return [];
  if (use.settings.price !== undefined || priceOf(cost, use.model) !== undefined) return [];
  return [
    {
      code: "model.no-price",
      key: use.key,
      value: use.model,
      model: use.model,
      supported: `${provider.options.name} prices only ${Object.keys(cost.prices).join(", ")}`,
    },
  ];
}

/**
 * The provider's instance for its capabilities: an HTTP one's own; a transport's from the
 * container only when its class has `capabilities` (else it stays uncreated until its first call).
 */
const handlerOf = (
  provider: RegisteredModelProvider,
  options: ModelCheckOptions,
): ModelProviderHandler | undefined =>
  provider.handler ??
  (hasProviderMethod(provider.type, "capabilities")
    ? options.transports?.(provider.type)
    : undefined);

/** What checks a provider's models: its `capabilities`, when it has them (a transport may not, #385). */
interface ProviderCheck {
  readonly provider: RegisteredModelProvider;
  readonly handler: ModelProviderHandler | undefined;
  readonly connection: ProviderConnection;
}

async function useProblems(use: ModelUse, check: ProviderCheck): Promise<readonly ModelProblem[]> {
  const { provider, handler, connection } = check;
  const capabilitiesOf = handler?.capabilities?.bind(handler);
  // a transport without capabilities (most SDKs list none): only its prices are checked
  if (capabilitiesOf === undefined) return priceProblems(use, provider);
  const capabilities = await capabilitiesOf(use.model, connection);
  if (capabilities === undefined) {
    return [
      {
        code: "model.unknown-model",
        key: use.key,
        value: use.model,
        model: use.model,
        supported: `${provider.options.name} does not list it`,
      },
    ];
  }
  const effective = {
    reasoning: use.settings?.reasoning ?? provider.options.reasoning,
    promptCaching: use.settings?.promptCaching ?? provider.options.promptCaching,
  };
  return [...settingProblems(use, effective, capabilities), ...priceProblems(use, provider)];
}

/**
 * Checks every model use against what its provider says the model supports — **all** problems at
 * once, each with the setting's key, its value, the model and what the model supports. Nothing is
 * replaced by a nearby setting. Runs at startup and in `agboss check --models`, before any model call.
 */
export async function checkModelUses(
  uses: readonly ModelUse[],
  directory: ModelProviderDirectory,
  options: ModelCheckOptions,
): Promise<readonly ModelProblem[]> {
  const connections = new Map<string, ProviderConnection>();
  const connectionFor = (provider: RegisteredModelProvider): ProviderConnection => {
    const known = connections.get(provider.options.name);
    if (known !== undefined) return known;
    const made = connectionOf(provider.options, {
      env: options.env,
      environment: options.environment ?? NO_ENVIRONMENT_VALUES,
      requireKeys: false,
      ...(options.send === undefined ? {} : { send: options.send }),
    });
    connections.set(provider.options.name, made);
    return made;
  };
  const found = await Promise.all(
    uses.map((use) => {
      const resolution = directory.resolve(use);
      return resolution.kind === "problem"
        ? Promise.resolve([resolution.problem])
        : useProblems(use, {
            provider: resolution.provider,
            handler: handlerOf(resolution.provider, options),
            connection: connectionFor(resolution.provider),
          });
    }),
  );
  return found.flat();
}
