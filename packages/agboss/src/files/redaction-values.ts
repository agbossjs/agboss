import type { AgentsConfigOf } from "../config/types.js";
import { circuitBreakerPolicyOf, isHttpProvider } from "../models/model-provider.decorator.js";
import type { RegisteredModelProvider } from "../models/resolve.js";
import type { ModelUse } from "../models/uses.js";
import type { ResolvedModelFiles } from "./file-settings.js";
import { FileView, RedactionValues } from "./model-files.js";

/** The values a redactor is handed: the execution's exact values only where the settings let them go (#899 §6). */
export const valuesForRedactor = (
  settings: Pick<ResolvedModelFiles, "redactionSendsValues">,
  values: readonly string[],
): readonly string[] => (settings.redactionSendsValues === true ? values : []);

/** The provider a model use resolves to, with the model: what "the same provider" is decided from. */
interface UsedProvider {
  readonly provider: RegisteredModelProvider;
  readonly model: string;
}

/** The vendor an aggregator names a model by: `google` of `google/gemini-2.5-flash-lite`; none without a `/`. */
const vendorOf = (model: string): string | undefined =>
  model.includes("/") ? model.slice(0, model.indexOf("/")) : undefined;

/** Whether two provider classes are one server under one set of credentials: the same base URL and the same key field. */
function isSameServerAndKey(a: RegisteredModelProvider, b: RegisteredModelProvider): boolean {
  const [x, y] = [a.options, b.options];
  return (
    isHttpProvider(x) &&
    isHttpProvider(y) &&
    x.apiKey !== undefined &&
    x.apiKey === y.apiKey &&
    x.baseUrl === y.baseUrl &&
    x.baseUrlField === y.baseUrlField
  );
}

/**
 * Whether the redaction model is "the same provider" as the agent's own, fail-closed (#899 §6): the same
 * provider, or one on the same base URL with the same key field — never judged by a display name two
 * providers could share. It is not the same when the redaction provider's breaker can fail over to another
 * provider (the values would go there), and not when the two models are of different vendors: an aggregator
 * such as OpenRouter serves them all, and its model is the one that gets the data. In doubt: not the same.
 */
export function isSameProvider(agent: UsedProvider, redactor: UsedProvider): boolean {
  if (circuitBreakerPolicyOf(redactor.provider.options)?.fallback !== undefined) return false;
  if (vendorOf(agent.model) !== vendorOf(redactor.model)) return false;
  return (
    agent.provider.type === redactor.provider.type ||
    isSameServerAndKey(agent.provider, redactor.provider)
  );
}

/** Whether the setting, and the providers of the agent's and the redactor's uses, let the values go. */
function sendsValuesOf(
  setting: RedactionValues | undefined,
  agent: ModelUse | undefined,
  redactor: ModelUse | undefined,
  providerOf: (use: ModelUse) => RegisteredModelProvider | undefined,
): boolean {
  if (setting === RedactionValues.Always) return true;
  if (setting !== RedactionValues.SameProvider || agent === undefined || redactor === undefined)
    return false;
  const agentProvider = providerOf(agent);
  const redactorProvider = providerOf(redactor);
  return (
    agentProvider !== undefined &&
    redactorProvider !== undefined &&
    isSameProvider(
      { provider: agentProvider, model: agent.model },
      { provider: redactorProvider, model: redactor.model },
    )
  );
}

/**
 * Whether an agent's redaction model gets the execution's exact PII values (#899 §6): by default only
 * where it is the same provider as the agent's own model (`isSameProvider`) — the agent's model already
 * reads the file there, so the values add no reader — never on another, unless
 * `redactionValues: RedactionValues.Always`; `Never` sends the kinds only. A project's own redactor is no
 * model of the agent's provider: it gets the values only on `Always`. (A context value that is `sensitive`
 * is masked in the agent's text before its model sees it; the redactor's provider reads the unredacted
 * image either way, and the values are what it would learn on top — hence the strict identity.)
 */
export function withRedactionValues(
  config: AgentsConfigOf<string>,
  uses: readonly ModelUse[],
  providerOf: (use: ModelUse) => RegisteredModelProvider | undefined,
): AgentsConfigOf<string> {
  const useOf = (key: string): ModelUse | undefined => uses.find((use) => use.key === key);
  return {
    ...config,
    agents: Object.fromEntries(
      Object.entries(config.agents).map(([name, settings]) => {
        const { files } = settings;
        if (files?.views.includes(FileView.Redacted) !== true) return [name, settings];
        const sends = sendsValuesOf(
          files.redactionValues,
          useOf(`agents.${name}`),
          useOf(`files.redactor.${name}`),
          providerOf,
        );
        return [name, { ...settings, files: { ...files, redactionSendsValues: sends } }];
      }),
    ),
  };
}
