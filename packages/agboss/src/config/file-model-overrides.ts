import type { ComponentModelOverrides } from "../models/model-cascade.js";
import { FileView } from "../files/model-files.js";
import type { AgentsConfigOf } from "./types.js";

/**
 * The models a profile gives the built-in file transcriber and redactor (`fileTranscribers`, `fileMaskers`,
 * by the agent\'s name) in the workflow\'s config, so that every reader of an agent\'s file models — the
 * provider checks at start, the model registry, `describe` — sees them. A key whose agent does not read
 * that view is left unreached, which is the typo the profile check names.
 */
export function withFileModels(
  config: AgentsConfigOf<string>,
  overrides: ComponentModelOverrides,
): AgentsConfigOf<string> {
  if (overrides.byKey.size === 0) return config;
  const modelOf = (key: string): string | undefined => {
    const model = overrides.byKey.get(key)?.model;
    if (model !== undefined) overrides.reached.add(key);
    return model;
  };
  const agents = Object.entries(config.agents).map(([name, agent]) => {
    const { files } = agent;
    if (files === undefined) return [name, agent] as const;
    const transcriber = files.views.includes(FileView.Transcription)
      ? modelOf(`fileTranscribers.${name}`)
      : undefined;
    const redactor = files.views.includes(FileView.Redacted)
      ? modelOf(`fileMaskers.${name}`)
      : undefined;
    return [
      name,
      {
        ...agent,
        files: {
          ...files,
          ...(transcriber === undefined ? {} : { transcriptionModel: transcriber }),
          ...(redactor === undefined ? {} : { redactionModel: redactor }),
        },
      },
    ] as const;
  });
  return { ...config, agents: Object.fromEntries(agents) };
}
