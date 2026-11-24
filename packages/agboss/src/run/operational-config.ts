import type { AgentsConfigOf } from "../config/types.js";

/**
 * What is operational in a workflow's config (#1318): limits and retry counts an operator
 * tunes per profile without changing what a model is asked or which model answers. A paused run
 * resumes under other values of them, so they are in neither the `configHash` nor the `modelVersion`.
 * (A retention `ttl` and a provider's fallback, resilience and routing are no part of the config the
 * hashes read at all: a profile changes them freely.)
 */

const without = <T extends object>(value: T, keys: readonly string[]): Partial<T> =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key))) as Partial<T>;

const mapValues = <T extends object>(
  record: Readonly<Record<string, T>>,
  change: (one: T) => object,
): Record<string, object> =>
  Object.fromEntries(Object.entries(record).map(([name, one]) => [name, change(one)]));

/** The config without its operational limits: what the hashes of a resume and of the models read. */
export function withoutOperational(config: AgentsConfigOf<string>): object {
  const { defaults, agents } = config;
  return {
    ...config,
    defaults: {
      ...defaults,
      tools: defaults.tools && without(defaults.tools, ["maxToolCalls", "maxResultSize"]),
    },
    agents: mapValues(agents, (agent) => without(agent, ["maxToolCalls", "maxRetries"])),
  };
}

/** The models of the judges and of the compactions that write summaries, by name. */
export const componentModels = (config: AgentsConfigOf<string>): object => ({
  ...(config.judges === undefined ? {} : { judges: config.judges }),
  ...(config.compactions === undefined
    ? {}
    : {
        compactions: Object.entries(config.compactions).map(([name, one]) => ({
          name,
          model: one.model,
        })),
      }),
});
