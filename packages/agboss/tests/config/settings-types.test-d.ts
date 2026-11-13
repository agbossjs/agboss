import type { z } from "zod";
import type {
  AgentSettingsSchema,
  AgentsConfigSchema,
  CompactionSettingsSchema,
  MaxTokensSchema,
  McpServerConfigSchema,
  PriceSchema,
} from "../../src/config/types.js";
import type {
  AgentSettings,
  AgentsConfig,
  CompactionSettings,
  MaxTokens,
  McpServerConfig,
  Price,
} from "../../src/config/settings-types.js";

/**
 * #895: the public settings types are written out and the schemas are internal, so the zod version
 * and the shape of a schema are no part of the API. Each pair below must be the same type: the
 * compile error `true` is not assignable to `false` names the pair whose fields drifted.
 *
 * `Plain` writes both sides in one spelling (enum members as their string, a mapped object, no
 * intersection), so what is compared is the shape: field names, optionality, value types.
 */
type Plain<T> = T extends string
  ? `${T}`
  : T extends readonly (infer E)[]
    ? Plain<E>[]
    : T extends object
      ? { [K in keyof T]: Plain<T[K]> }
      : T;
type Identical<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Same<A, B> = Identical<Plain<A>, Plain<B>>;

export const price: Same<z.infer<typeof PriceSchema>, Price> = true;
export const maxTokens: Same<z.infer<typeof MaxTokensSchema>, MaxTokens> = true;
export const agentSettings: Same<z.infer<typeof AgentSettingsSchema>, AgentSettings> = true;
export const compactionSettings: Same<
  z.infer<typeof CompactionSettingsSchema>,
  CompactionSettings
> = true;
export const mcpServerConfig: Same<z.infer<typeof McpServerConfigSchema>, McpServerConfig> = true;
export const agentsConfig: Same<z.infer<typeof AgentsConfigSchema>, AgentsConfig> = true;
