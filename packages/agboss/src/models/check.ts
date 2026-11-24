import type { Environment } from "../flow/generated-types.js";
import { NO_ENVIRONMENT_VALUES } from "../environments/resolve.js";
import { connectionOf } from "./connections.js";
import { priceOf } from "./cost.js";
import { fallbackProblems } from "./fallback-check.js";
import type { ModelProviderHandler, ProviderConnection } from "./handler.js";
import { inputProblems } from "./input-check.js";
import { sharedInputs } from "./capabilities.js";
import type { ModelInputKind } from "./content.js";
import { hasProviderMethod } from "./model-provider.decorator.js";
import type { TransportResolver } from "./transport/transport-resolver.js";
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
  readonly transports?: Pick<TransportResolver, "instanceOf">;
  /**
   * Also each provider's host routing against the endpoints of every model it serves (#395 PR 6:
   * OpenRouter's pinned hosts and quantizations) — `agboss check --models` only, never at startup.
   */
  readonly endpoints?: boolean;
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
  // no cost: the provider is unpriced, its calls are recorded at 0 USD with their tokens (#1313)
  if (cost === undefined || cost.kind === "from-response" || use.settings === undefined) return [];
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
    ? options.transports?.instanceOf(provider.type)
    : undefined);

/** What checks a provider's models: its `capabilities`, when it has them (a transport may not, #385). */
interface ProviderCheck {
  readonly provider: RegisteredModelProvider;
  readonly handler: ModelProviderHandler | undefined;
  readonly connection: ProviderConnection;
  /** Whether the routing is checked against the model's endpoints (`ModelCheckOptions.endpoints`). */
  readonly endpoints: boolean;
}

/** The provider's routing no endpoint of the model serves: `[model.no-matching-endpoint]`. */
async function endpointProblems(use: ModelUse, check: ProviderCheck): Promise<ModelProblem[]> {
  const routingProblemsOf = check.handler?.routingProblems?.bind(check.handler);
  if (!check.endpoints || routingProblemsOf === undefined) return [];
  const found = await routingProblemsOf(use.model, check.connection);
  return found.map(({ value, supported }) => ({
    code: "model.no-matching-endpoint",
    key: use.key,
    value,
    model: use.model,
    supported: `${check.provider.options.name}: ${supported}`,
  }));
}

/** What checking one use found: its problems, and the kinds of input its model says it takes. */
interface UseResult {
  readonly problems: readonly ModelProblem[];
  readonly inputs?: readonly ModelInputKind[];
}

async function useResult(use: ModelUse, check: ProviderCheck): Promise<UseResult> {
  const { provider, handler, connection } = check;
  const capabilitiesOf = handler?.capabilities?.bind(handler);
  // a transport without capabilities (most SDKs list none): only its prices are checked
  if (capabilitiesOf === undefined) return { problems: priceProblems(use, provider) };
  const capabilities = await capabilitiesOf(use.model, connection);
  if (capabilities === undefined) {
    return {
      problems: [
        {
          code: "model.unknown-model",
          key: use.key,
          value: use.model,
          model: use.model,
          supported: `${provider.options.name} does not list it`,
        },
      ],
    };
  }
  const effective = {
    reasoning: use.settings?.reasoning ?? provider.options.reasoning,
    promptCaching: use.settings?.promptCaching ?? provider.options.promptCaching,
  };
  const problems = [
    ...settingProblems(use, effective, capabilities),
    ...inputProblems(use, capabilities),
    ...priceProblems(use, provider),
    ...(await endpointProblems(use, check)),
  ];
  return {
    problems,
    ...(capabilities.inputs === undefined ? {} : { inputs: capabilities.inputs }),
  };
}

/**
 * A use's inputs against its provider's fallback model too (#899, #202): a call that falls back
 * must read what the primary reads — a strict use is refused otherwise, a defaulted one narrows to
 * what both read.
 */
async function fallbackInputs(
  use: ModelUse,
  provider: RegisteredModelProvider,
  directory: ModelProviderDirectory,
  options: ModelCheckOptions,
  connectionFor: (provider: RegisteredModelProvider) => ProviderConnection,
): Promise<UseResult> {
  const mapped = provider.options.circuitBreakerPolicy?.fallbackModels?.[use.model];
  if (mapped === undefined) return { problems: [] };
  const resolution = directory.resolve({ ...use, model: mapped });
  if (resolution.kind === "problem") return { problems: [] };
  const handler = handlerOf(resolution.provider, options);
  const capabilities = await handler?.capabilities?.(mapped, connectionFor(resolution.provider));
  if (capabilities === undefined) return { problems: [] };
  return {
    problems: use.isNeedStrict === true ? inputProblems(use, capabilities, mapped) : [],
    ...(capabilities.inputs === undefined ? {} : { inputs: capabilities.inputs }),
  };
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
  return (await checkedModelUses(uses, directory, options)).problems;
}

/** What `checkModelUses` found: the problems, and the input kinds each use's model takes, by use key (#899). */
export interface ModelCheck {
  readonly problems: readonly ModelProblem[];
  readonly inputs: ReadonlyMap<string, readonly ModelInputKind[]>;
}

/** One use: its own model's check, and its provider's fallback model's inputs. */
async function checkedUse(
  use: ModelUse,
  directory: ModelProviderDirectory,
  options: ModelCheckOptions,
  connectionFor: (provider: RegisteredModelProvider) => ProviderConnection,
): Promise<UseResult> {
  const resolution = directory.resolve(use);
  if (resolution.kind === "problem") return { problems: [resolution.problem] };
  const check = {
    provider: resolution.provider,
    handler: handlerOf(resolution.provider, options),
    connection: connectionFor(resolution.provider),
    endpoints: options.endpoints === true,
  };
  const own = await useResult(use, check);
  const backup = await fallbackInputs(use, resolution.provider, directory, options, connectionFor);
  const inputs = sharedInputs(own.inputs, backup.inputs);
  return {
    problems: [...own.problems, ...backup.problems],
    ...(inputs === undefined ? {} : { inputs }),
  };
}

/** `checkModelUses` with what the models said of their inputs: a defaulted set of media types narrows to it. */
export async function checkedModelUses(
  uses: readonly ModelUse[],
  directory: ModelProviderDirectory,
  options: ModelCheckOptions,
): Promise<ModelCheck> {
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
    uses.map((use) => checkedUse(use, directory, options, connectionFor)),
  );
  const inputs = new Map(
    found.flatMap((result, index) => {
      const use = uses[index];
      return use === undefined || result.inputs === undefined
        ? []
        : [[use.key, result.inputs] as const];
    }),
  );
  return { problems: found.flatMap((result) => result.problems), inputs };
}
