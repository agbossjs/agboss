import type { AgentsConfigOf } from "../config/types.js";
import { createProviderGateway, type ModelGateway } from "../llm/gateway.js";
import type { Environment } from "../flow/generated-types.js";
import type { Infrastructure } from "../infrastructure/contracts.js";
import { chatExtensionsFor, type ProviderClientOptions } from "../llm/provider-clients.js";
import type { TransportResolver } from "../models/transport/transport-resolver.js";
import { systemClock } from "../infrastructure/clock.js";
import { lateTransports, type TransportContainer } from "./late-transports.js";
import { providerCallsOf } from "../models/calls/provider-calls.js";
import type { ProviderFetch } from "../models/resilient-fetch.js";
import type { ChaosOptions } from "../eval/chaos/chaos-failure.js";
import { modelChaosOf } from "../eval/chaos/model-chaos.js";
import { checkModelUses, resolutionProblems } from "../models/check.js";
import { ConfigurationError } from "../models/problems.js";
import { modelGuardrailsOf } from "../guardrails/loaded.js";
import { modelUsesOf } from "../models/uses.js";
import { directoryOf, modelSummaryOf, withProviderPrices } from "../models/workflow-models.js";
import type { AssembledWorkflow } from "../workflow.js";

/** The models of an app: its gateway, its config priced by the providers, the startup log lines. */
export interface AppModels {
  readonly gateway: ModelGateway;
  /**
   * Every setting against what its model supports (production gateway only) — run once the
   * application's container can create transport providers (#385), before any model call.
   */
  readonly checkModels: () => Promise<void>;
  readonly priced: (config: AgentsConfigOf<string>) => AgentsConfigOf<string>;
  readonly summary: readonly string[];
}

/**
 * The production clients' options from the app's: the process environment (base URLs), the
 * application's environment (its `applicationContext.environment`: the keys), the instance's clock and shared calls — rate limits, 429
 * pauses and breakers in its `RateLimitRepository` — and, in tests, a stub client.
 */
/** What an app's models are made with: its stub client and process (tests), a given gateway. */
export interface AppModelsOptions {
  readonly providerFetch?: ProviderFetch;
  /** Failures injected into every model call (#396 PR 6). */
  readonly chaos?: ChaosOptions;
  readonly processEnv?: NodeJS.ProcessEnv;
  readonly gateway?: ModelGateway | undefined;
  /**
   * A gateway over the real one (#439: VCR) — `real` builds, on its first call, the providers'
   * gateway as `createApp` builds its own: the chat extensions loaded, transport providers created by
   * the application's container (#385). Takes the place of `gateway`; no model check runs.
   */
  readonly gatewayOverProviders?: GatewayOverProviders | undefined;
}

/** Wraps the providers' gateway, built only when `real` is first called (#439). */
export type GatewayOverProviders = (real: () => ModelGateway) => ModelGateway;

export const providerClientsOf = (
  options: AppModelsOptions,
  application: { readonly environment: Environment },
  infrastructure: Pick<Infrastructure, "clock" | "rateLimits">,
  transports?: TransportResolver,
): ProviderClientOptions => ({
  ...(transports === undefined ? {} : { transports }),
  env: options.processEnv ?? process.env,
  environment: application.environment,
  clock: infrastructure.clock,
  calls: providerCallsOf(infrastructure.rateLimits, infrastructure.clock),
  ...sendOf(options),
});

/** The raw client, with chaos in it when the run injects some (#396 PR 6); transports get it too. */
function sendOf(options: AppModelsOptions): Pick<ProviderClientOptions, "send" | "chaos"> {
  if (options.chaos === undefined)
    return options.providerFetch === undefined ? {} : { send: options.providerFetch };
  const chaos = modelChaosOf(options.chaos);
  return { send: chaos.fetchOf(options.providerFetch ?? fetch), chaos };
}

/**
 * Fails fast, before any model call: every model must have exactly one provider; with the
 * production gateway (none given), every setting is also checked against what its model supports.
 */
export async function modelsFor(
  bundle: AssembledWorkflow,
  given: ModelGateway | undefined,
  clients: ProviderClientOptions,
): Promise<AppModels> {
  const directory = directoryOf(bundle.modelProviders);
  const uses = modelUsesOf(bundle.config, bundle.routers, {
    piiDetectors: bundle.pii?.detectors,
    interpreters: bundle.replyInterpreters,
    guardrails: modelGuardrailsOf(bundle.guardrails),
  });
  const unresolved = resolutionProblems(uses, directory);
  if (unresolved.length > 0) throw new ConfigurationError(unresolved);
  // the production gateway reads every provider's key: a missing one fails before the model check
  const gateway =
    given ?? createProviderGateway(directory, clients, await chatExtensionsFor(directory));
  const checkModels = async (): Promise<void> => {
    if (given !== undefined) return;
    const problems = await checkModelUses(uses, directory, clients);
    if (problems.length > 0) throw new ConfigurationError(problems);
  };
  return {
    gateway,
    checkModels,
    priced: (config) => withProviderPrices(config, directory),
    summary: modelSummaryOf(uses, directory),
  };
}

/**
 * The wrapped providers' gateway (#439): what recording talks to — in real time, no rate limit or
 * breaker of a test — with the transports of the application's container.
 */
async function overProviders(
  bundle: AssembledWorkflow,
  over: GatewayOverProviders,
  clients: Pick<ProviderClientOptions, "env" | "environment" | "transports">,
): Promise<ModelGateway> {
  const directory = directoryOf(bundle.modelProviders);
  const extensions = await chatExtensionsFor(directory);
  let real: ModelGateway | undefined;
  return over(
    () =>
      (real ??= createProviderGateway(directory, { ...clients, clock: systemClock }, extensions)),
  );
}

/** A workflow's models with its transport providers (#385) bound to the container once it exists. */
export interface StartingModels extends Omit<AppModels, "checkModels"> {
  /** Binds the application's container (transport providers) and checks every setting. */
  readonly startModels: (container: TransportContainer) => Promise<void>;
}

/**
 * The models of one workflow of an application: its gateway over the application's model
 * providers, a transport one created by the application's container on its first call — the
 * container is made after the gateway, so `startModels` binds it, then runs the model check.
 */
export async function appModelsFor(
  bundle: AssembledWorkflow,
  options: AppModelsOptions,
  parts: { readonly infrastructure: Pick<Infrastructure, "clock" | "rateLimits"> },
  contexts: { readonly application: { readonly environment: Environment } },
): Promise<StartingModels> {
  const transports = lateTransports();
  const { infrastructure } = parts;
  const clients = providerClientsOf(
    options,
    contexts.application,
    infrastructure,
    transports.resolver,
  );
  const given = options.gatewayOverProviders
    ? await overProviders(bundle, options.gatewayOverProviders, {
        env: clients.env,
        environment: clients.environment,
        transports: transports.resolver,
      })
    : options.gateway;
  const { checkModels, ...models } = await modelsFor(bundle, given, clients);
  const startModels = async (container: TransportContainer): Promise<void> => {
    transports.bind(container);
    await checkModels();
  };
  return { ...models, startModels };
}
