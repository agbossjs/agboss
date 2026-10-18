import type { Environment } from "../flow/generated-types.js";
import { NO_ENVIRONMENT_VALUES } from "../environments/resolve.js";
import { connectionOf } from "./connections.js";
import { priceOf } from "./cost.js";
import { fallbackProblems } from "./fallback-check.js";
import type { ProviderConnection } from "./handler.js";
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

async function useProblems(
  use: ModelUse,
  provider: RegisteredModelProvider,
  connection: ProviderConnection,
): Promise<readonly ModelProblem[]> {
  const capabilities = await provider.handler.capabilities(use.model, connection);
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
        : useProblems(use, resolution.provider, connectionFor(resolution.provider));
    }),
  );
  return found.flat();
}
