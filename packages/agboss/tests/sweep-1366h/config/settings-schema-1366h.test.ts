/**
 * #1366: the config schemas admit exactly the settings they document - price, token ceiling, reasoning,
 * prompt caching, temperature, turn window, compaction, agent (with knowledge bases), router model,
 * MCP server and workflow name/defaults - and a config with an unknown tool fails with
 * `UnknownAgentToolError` (an agent without tools never does).
 */
import { describe, expect, it } from "vitest";
import {
  AgentSettingsSchema,
  AgentsConfigSchema,
  CacheSettingSchema,
  ChatDefaultsSchema,
  CompactionSettingsSchema,
  JevRouterModelSchema,
  MaxTokensSchema,
  McpServerConfigSchema,
  ModelSettingsSchema,
  PriceSchema,
  PromptCachingValueSchema,
  ReasoningValueSchema,
  RouterModelSchema,
  ThinkingSchema,
  UncompactedTurnsSchema,
  UnknownAgentToolError,
  validateAgentsConfig,
  type AgentsConfigOf,
} from "../../../src/config/types.js";
import { testConfig } from "../../helpers.js";

interface Parser {
  safeParse(value: unknown): { success: boolean };
}
const admits = (schema: Parser, ...values: unknown[]): void => {
  for (const value of values)
    expect(schema.safeParse(value).success, JSON.stringify(value)).toBe(true);
};
const refuses = (schema: Parser, ...values: unknown[]): void => {
  for (const value of values)
    expect(schema.safeParse(value).success, JSON.stringify(value)).toBe(false);
};

const agent = { model: "m", description: "d" };
const config = (patch: Record<string, unknown>) => ({ ...testConfig, ...patch });

describe("config schemas", () => {
  it("price: non-negative numbers, the cache prices optional", () => {
    admits(PriceSchema, { inputPerMTok: 0, outputPerMTok: 1 });
    admits(PriceSchema, {
      inputPerMTok: 1,
      outputPerMTok: 2,
      cacheReadPerMTok: 0,
      cacheWritePerMTok: 3,
    });
    refuses(PriceSchema, { inputPerMTok: -1, outputPerMTok: 1 }, { inputPerMTok: 1 }, {});
    refuses(PriceSchema, { inputPerMTok: 1, outputPerMTok: 1, cacheReadPerMTok: -1 });
  });

  it("max tokens: a positive integer or max", () => {
    admits(MaxTokensSchema, 1, 8192, "max");
    refuses(MaxTokensSchema, 0, -5, 1.5, "all", "");
  });

  it("reasoning value: model-decides, on (effort, budget), off", () => {
    admits(ReasoningValueSchema, { kind: "model-decides" }, { kind: "off" }, { kind: "on" });
    admits(ReasoningValueSchema, { kind: "on", effort: "high", budget: { tokens: 10 } });
    refuses(ReasoningValueSchema, { kind: "other" }, { kind: "on", effort: "huge" });
    refuses(
      ReasoningValueSchema,
      { kind: "on", budget: { tokens: 0 } },
      { kind: "on", budget: {} },
    );
    refuses(ReasoningValueSchema, { kind: "on", budget: { tokens: 1.5 } });
  });

  it("thinking: default, an effort, a token budget or a reasoning value", () => {
    admits(ThinkingSchema, "default", "none", "high", { budgetTokens: 5 }, { kind: "off" });
    refuses(ThinkingSchema, "bogus", { budgetTokens: 0 }, { budgetTokens: 1.5 }, 3);
  });

  it("prompt caching value: where-supported with at least one cached part, or off", () => {
    const base = { kind: "where-supported", retention: "5m", cachedParts: ["system-prompt"] };
    admits(PromptCachingValueSchema, { kind: "off" }, base, { ...base, key: "abc" });
    admits(PromptCachingValueSchema, {
      ...base,
      cachedParts: ["system-prompt", "tools", "history"],
    });
    refuses(PromptCachingValueSchema, { ...base, cachedParts: [] }, { ...base, key: "" });
    refuses(PromptCachingValueSchema, { ...base, retention: "2m" }, { kind: "other" });
    refuses(PromptCachingValueSchema, { ...base, cachedParts: ["bogus"] });
  });

  it("cache setting: a boolean or a caching value", () => {
    admits(CacheSettingSchema, true, false, { kind: "off" });
    refuses(CacheSettingSchema, "yes", { kind: "x" });
  });

  it("chat defaults and model settings: temperature 0..2, model not empty", () => {
    admits(ChatDefaultsSchema, { temperature: 0 }, { temperature: 1 }, { temperature: 2 });
    admits(ChatDefaultsSchema, {
      temperature: 0.5,
      maxTokens: "max",
      thinking: "low",
      cache: true,
    });
    refuses(ChatDefaultsSchema, { temperature: -0.1 }, { temperature: 2.1 }, {});
    refuses(ChatDefaultsSchema, { temperature: 1, maxTokens: 0 });
    admits(ModelSettingsSchema, { model: "abc" }, { model: "a", temperature: 0 });
    admits(ModelSettingsSchema, { model: "abc", temperature: 1 }, { model: "abc", temperature: 2 });
    refuses(ModelSettingsSchema, { model: "" }, { model: "a", temperature: -1 }, {});
    refuses(
      ModelSettingsSchema,
      { model: "a", temperature: 3 },
      { model: "a", price: { inputPerMTok: -1, outputPerMTok: 0 } },
    );
  });

  it("uncompacted turns: a whole number from 0, or all", () => {
    admits(UncompactedTurnsSchema, 0, 7, "all");
    refuses(UncompactedTurnsSchema, -1, 1.5, "some");
  });

  it("compaction settings: a known strategy, positive counts, a model", () => {
    admits(CompactionSettingsSchema, { strategy: "none" });
    admits(CompactionSettingsSchema, {
      strategy: "summary-queue",
      model: { model: "m" },
      turnsBetweenCompactions: 3,
      summaryQueueLength: 2,
    });
    refuses(CompactionSettingsSchema, {}, { strategy: "bogus" });
    refuses(CompactionSettingsSchema, { strategy: "none", turnsBetweenCompactions: 0 });
    refuses(CompactionSettingsSchema, { strategy: "none", summaryQueueLength: 0 });
    refuses(CompactionSettingsSchema, { strategy: "none", model: { model: "" } });
  });

  it("agent settings: a description, limits, knowledge bases with their reranking", () => {
    admits(AgentSettingsSchema, agent, { ...agent, tools: ["a"], maxToolCalls: 0, maxRetries: 0 });
    refuses(
      AgentSettingsSchema,
      { model: "m", description: "" },
      { model: "m" },
      { ...agent, maxToolCalls: -1 },
    );
    const kb = { name: "docs", mode: "tool", topK: 3, tenancy: "shared" };
    admits(AgentSettingsSchema, { ...agent, rag: [kb] });
    admits(AgentSettingsSchema, {
      ...agent,
      rag: [{ ...kb, rerank: { reranker: "r", candidates: 10, onFailure: "fallback" } }],
    });
    refuses(
      AgentSettingsSchema,
      { ...agent, rag: [{ ...kb, topK: 0 }] },
      { ...agent, rag: [{ mode: "tool" }] },
    );
    refuses(
      AgentSettingsSchema,
      { ...agent, rag: [{ ...kb, mode: "bogus" }] },
      { ...agent, rag: [{ ...kb, tenancy: "x" }] },
    );
    refuses(AgentSettingsSchema, {
      ...agent,
      rag: [{ ...kb, rerank: { reranker: "r", candidates: 0, onFailure: "fallback" } }],
    });
    refuses(AgentSettingsSchema, {
      ...agent,
      rag: [{ ...kb, rerank: { reranker: "r", candidates: 5, onFailure: "x" } }],
    });
    refuses(AgentSettingsSchema, { ...agent, rag: [{ ...kb, rerank: {} }] });
  });

  it("router model: jev or llm, each with a model", () => {
    admits(JevRouterModelSchema, { kind: "jev", model: "x" });
    refuses(JevRouterModelSchema, { kind: "jev", model: "" }, { kind: "llm", model: "x" });
    admits(RouterModelSchema, { kind: "jev", model: "x" }, { kind: "llm", model: "x" });
    refuses(
      RouterModelSchema,
      { kind: "other", model: "x" },
      { kind: "llm", model: "" },
      { kind: "llm" },
    );
  });

  it("mcp servers: stdio with a command, http with a url, an optional target", () => {
    const target = { application: "app", expose: "tool" };
    admits(McpServerConfigSchema, { transport: "stdio", command: "run" });
    admits(McpServerConfigSchema, {
      transport: "stdio",
      command: "run",
      target,
      args: ["a"],
      env: ["K"],
    });
    admits(McpServerConfigSchema, { transport: "http", url: "https://example.com/mcp" });
    admits(McpServerConfigSchema, {
      transport: "http",
      url: "https://example.com/mcp",
      target,
      headers: { a: "B" },
    });
    refuses(McpServerConfigSchema, { transport: "stdio", command: "" }, { transport: "stdio" });
    refuses(McpServerConfigSchema, { transport: "ws", command: "run" });
    refuses(McpServerConfigSchema, { transport: "http", url: "nope" });
    refuses(McpServerConfigSchema, {
      transport: "stdio",
      command: "run",
      target: { application: "", expose: "t" },
    });
    refuses(McpServerConfigSchema, {
      transport: "stdio",
      command: "run",
      target: { application: "a", expose: "" },
    });
    refuses(McpServerConfigSchema, {
      transport: "http",
      url: "https://e.com",
      target: { application: "a" },
    });
  });

  it("workflow config: a name of lowercase letters, digits and dashes; a version; defaults", () => {
    admits(
      AgentsConfigSchema,
      testConfig,
      config({ name: "a" }),
      config({ name: "a-b1" }),
      config({ name: "1a" }),
    );
    admits(AgentsConfigSchema, config({ name: "abc" }), config({ name: "ab" }));
    refuses(
      AgentsConfigSchema,
      config({ name: "" }),
      config({ name: "-a" }),
      config({ name: "Ab" }),
    );
    refuses(
      AgentsConfigSchema,
      config({ name: "a_" }),
      config({ name: "a b" }),
      config({ name: "a\nb" }),
    );
    refuses(AgentsConfigSchema, config({ name: "_a" }), config({ name: "a-b\n_" }));
    refuses(AgentsConfigSchema, config({ version: "" }));
    admits(AgentsConfigSchema, config({ version: "1" }), config({ version: "1.2.3" }));
    refuses(
      AgentsConfigSchema,
      config({ defaults: {} }),
      config({ defaults: { ...testConfig.defaults, uncompactedTurns: -1 } }),
    );
    const tools = (value: unknown) =>
      config({ defaults: { ...testConfig.defaults, tools: value } });
    admits(AgentsConfigSchema, tools({ maxToolCalls: 0, maxResultSize: 1 }), tools({}));
    refuses(
      AgentsConfigSchema,
      tools({ maxToolCalls: -1 }),
      tools({ maxResultSize: 0 }),
      tools({ maxResultSize: 1.5 }),
    );
  });

  it("an unknown tool fails with UnknownAgentToolError; an agent without tools never does", () => {
    const withTools = (tools: string[]): AgentsConfigOf<string> => ({
      ...testConfig,
      agents: { alpha: { ...testConfig.agents.alpha, tools }, beta: testConfig.agents.beta },
    });

    expect(() => validateAgentsConfig(testConfig, ["known"])).not.toThrow();
    const thrown = (() => {
      try {
        validateAgentsConfig(withTools(["known", "x", "y"]), ["known"]);
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(thrown).toBeInstanceOf(UnknownAgentToolError);
    expect((thrown as Error).name).toBe("UnknownAgentToolError");
  });
});
