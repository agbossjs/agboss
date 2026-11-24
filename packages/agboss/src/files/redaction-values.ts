import type { AgentsConfigOf } from "../config/types.js";
import { isDriverOptions } from "../models/model-provider.decorator.js";
import { Secret, variableOfSecret } from "../environments/secret.js";
import type { DriverHeaders } from "../models/model-driver.js";
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

/** Whether two provider classes are one server under one key: drivers of the same dialect, base URL and key reference. */
function isSameServerAndKey(a: RegisteredModelProvider, b: RegisteredModelProvider): boolean {
  const [x, y] = [a.options, b.options];
  if (!isDriverOptions(x) || !isDriverOptions(y)) return false;
  const [one, other] = [x.driver.settings, y.driver.settings];
  return (
    x.driver.dialect === y.driver.dialect &&
    one.apiKey !== undefined &&
    other.apiKey !== undefined &&
    variableOf(one.apiKey) === variableOf(other.apiKey) &&
    sameText(one.baseUrl, other.baseUrl) &&
    sameHeaders(one.headers, other.headers) &&
    sameFields(x.driver.requestFields, y.driver.requestFields)
  );
}

/**
 * Whether two drivers' extra request fields are deep-equal (routing, extra fields, a path): fail-closed —
 * a value that is no plain JSON (a function, a cycle, a class instance) on either side is "not the same".
 */
function sameFields(
  a: Readonly<Record<string, unknown>>,
  b: Readonly<Record<string, unknown>>,
): boolean {
  const [left, right] = [canonical(a), canonical(b)];
  return left !== undefined && left === right;
}

/** A stable JSON text of plain data (keys sorted), or `undefined` when the value is not plain JSON. */
function canonical(value: unknown): string | undefined {
  try {
    return JSON.stringify(plain(value));
  } catch {
    return undefined;
  }
}

function plain(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(
      Object.entries(value)
        .sort(([x], [y]) => (x < y ? -1 : 1))
        .map(([key, item]) => [key, plain(item)]),
    );
  throw new TypeError("not plain data");
}

/** Two header sets are the same names with the same texts, or the same variables: another header may be another account. */
function sameHeaders(a: DriverHeaders | undefined, b: DriverHeaders | undefined): boolean {
  const [x, y] = [Object.entries(a ?? {}), Object.entries(b ?? {})];
  return (
    x.length === y.length &&
    x.every(([name, value]) => {
      const other = b?.[name];
      return other !== undefined && sameText(value, other);
    })
  );
}

/** Two base URLs are the same text, or the same variable. */
const sameText = (a: DriverHeaders[string], b: DriverHeaders[string]): boolean =>
  typeof a === "string" || typeof b === "string" ? a === b : variableOf(a) === variableOf(b);

/** The process variable a reference reads (`secret(…)` makes a `Secret`, `env(…)` a reference). */
const variableOf = (reference: Exclude<DriverHeaders[string], string>): string =>
  reference instanceof Secret ? variableOfSecret(reference) : reference.variable;

/**
 * Whether the redaction model is "the same provider" as the agent's own, fail-closed (#899 §6): the same
 * provider, or one on the same base URL with the same key — never judged by a display name two
 * providers could share. It is not the same when the redaction provider's breaker can fail over to another
 * provider (the values would go there), and not when the two models are of different vendors: an aggregator
 * such as OpenRouter serves them all, and its model is the one that gets the data. In doubt: not the same.
 */
export function isSameProvider(agent: UsedProvider, redactor: UsedProvider): boolean {
  if (redactor.provider.options.fallback !== undefined) return false;
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
          useOf(`fileMaskers.${name}`),
          providerOf,
        );
        return [name, { ...settings, files: { ...files, redactionSendsValues: sends } }];
      }),
    ),
  };
}
