import type { AgentsConfigOf } from "../config/types.js";
import { createProviderGateway, type ModelGateway } from "../llm/gateway.js";
import type { Environment } from "../flow/generated-types.js";
import type { Infrastructure } from "../infrastructure/contracts.js";
import type { ProviderClientOptions } from "../llm/provider-clients.js";
import { providerCallsOf } from "../models/calls/provider-calls.js";
import type { ProviderFetch } from "../models/resilient-fetch.js";
import { checkModelUses, resolutionProblems } from "../models/check.js";
import { ConfigurationError } from "../models/problems.js";
import { modelUsesOf } from "../models/uses.js";
import { directoryOf, modelSummaryOf, withProviderPrices } from "../models/workflow-models.js";
import type { AssembledWorkflow } from "../workflow.js";

/** The models of an app: its gateway, its config priced by the providers, the startup log lines. */
export interface AppModels {
  readonly gateway: ModelGateway;
  readonly priced: (config: AgentsConfigOf<string>) => AgentsConfigOf<string>;
  readonly summary: readonly string[];
}

/**
 * The production clients' options from the app's: the process environment (base URLs), the
 * application's environment (its `applicationContext.environment`: the keys), the instance's clock and shared calls — rate limits, 429
 * pauses and breakers in its `RateLimitRepository` — and, in tests, a stub client.
 */
export const providerClientsOf = (
  options: { readonly providerFetch?: ProviderFetch; readonly processEnv?: NodeJS.ProcessEnv },
  application: { readonly environment: Environment },
  infrastructure: Pick<Infrastructure, "clock" | "rateLimits">,
): ProviderClientOptions => ({
  env: options.processEnv ?? process.env,
  environment: application.environment,
  clock: infrastructure.clock,
  calls: providerCallsOf(infrastructure.rateLimits, infrastructure.clock),
  ...(options.providerFetch === undefined ? {} : { send: options.providerFetch }),
});

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
  });
  const unresolved = resolutionProblems(uses, directory);
  if (unresolved.length > 0) throw new ConfigurationError(unresolved);
  // the production gateway reads every provider's key: a missing one fails before the model check
  const gateway = given ?? createProviderGateway(directory, clients);
  if (given === undefined) {
    const problems = await checkModelUses(uses, directory, clients);
    if (problems.length > 0) throw new ConfigurationError(problems);
  }
  return {
    gateway,
    priced: (config) => withProviderPrices(config, directory),
    summary: modelSummaryOf(uses, directory),
  };
}
