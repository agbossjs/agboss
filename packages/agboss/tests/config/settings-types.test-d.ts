import { describe, expectTypeOf, it } from "vitest";
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
 * and the shape of a schema are no part of the API. Each pair below must be the same type: a field
 * added to one and not the other fails to compile.
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

describe("#895: each settings type equals what its schema infers", () => {
  it("Price", () => {
    expectTypeOf<Plain<z.infer<typeof PriceSchema>>>().toEqualTypeOf<Plain<Price>>();
  });

  it("MaxTokens", () => {
    expectTypeOf<Plain<z.infer<typeof MaxTokensSchema>>>().toEqualTypeOf<Plain<MaxTokens>>();
  });

  it("AgentSettings", () => {
    expectTypeOf<Plain<z.infer<typeof AgentSettingsSchema>>>().toEqualTypeOf<
      Plain<AgentSettings>
    >();
  });

  it("CompactionSettings", () => {
    expectTypeOf<Plain<z.infer<typeof CompactionSettingsSchema>>>().toEqualTypeOf<
      Plain<CompactionSettings>
    >();
  });

  it("McpServerConfig", () => {
    expectTypeOf<Plain<z.infer<typeof McpServerConfigSchema>>>().toEqualTypeOf<
      Plain<McpServerConfig>
    >();
  });

  it("AgentsConfig", () => {
    expectTypeOf<Plain<z.infer<typeof AgentsConfigSchema>>>().toEqualTypeOf<Plain<AgentsConfig>>();
  });
});
