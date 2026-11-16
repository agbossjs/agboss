import type { AgentsConfigOf } from "../config/types.js";
import type { ModelUse } from "../models/uses.js";
import type { ResolvedModelFiles } from "./file-settings.js";
import { FileView, RedactionValues } from "./model-files.js";

/** The values a redactor is handed: the execution's exact values only where the settings let them go (#899 §6). */
export const valuesForRedactor = (
  settings: Pick<ResolvedModelFiles, "redactionSendsValues">,
  values: readonly string[],
): readonly string[] => (settings.redactionSendsValues === true ? values : []);

/**
 * Whether an agent's redaction model gets the execution's exact PII values (#899 §6): by default only
 * where it is served by the same provider as the agent's own model — the data reaches that provider anyway —
 * never on another, unless `redactionValues: RedactionValues.Always`; `Never` sends the kinds only.
 * A project's own redactor is no model of the agent's provider: it gets the values only on `Always`.
 */
export function withRedactionValues(
  config: AgentsConfigOf<string>,
  uses: readonly ModelUse[],
  providerOf: (use: ModelUse) => string | undefined,
): AgentsConfigOf<string> {
  const useOf = (key: string): ModelUse | undefined => uses.find((use) => use.key === key);
  return {
    ...config,
    agents: Object.fromEntries(
      Object.entries(config.agents).map(([name, settings]) => {
        const { files } = settings;
        if (files?.views.includes(FileView.Redacted) !== true) return [name, settings];
        const agent = useOf(`agents.${name}`);
        const redactor = useOf(`files.redactor.${name}`);
        const agentProvider = agent === undefined ? undefined : providerOf(agent);
        const redactorProvider = redactor === undefined ? undefined : providerOf(redactor);
        const isSame = agentProvider !== undefined && agentProvider === redactorProvider;
        const sends =
          files.redactionValues === RedactionValues.Always ||
          (files.redactionValues === RedactionValues.SameProvider && isSame);
        return [name, { ...settings, files: { ...files, redactionSendsValues: sends } }];
      }),
    ),
  };
}
