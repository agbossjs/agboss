import { describe, expect, it } from "vitest";
import { TestWorkflow } from "./fixtures/test-workflow/test.workflow.js";
import { workflowOf } from "../src/testing/index.js";
import {
  UnknownAgentToolError,
  validateAgentsConfig,
  type AgentsConfig,
  type AgentsConfigOf,
} from "../src/config/types.js";
import { TokenLimit } from "../src/config/types.js";
import { testConfig } from "./helpers.js";

describe("validateAgentsConfig", () => {
  it("accepts the shipped config: Jev routers by default, model-max output", async () => {
    const config = validateAgentsConfig((await workflowOf(TestWorkflow)).config);

    expect(config.defaults.router?.kind).toBe("jev");
    expect(config.defaults.models.maxTokens).toBe(TokenLimit.MODEL_MAX);
  });

  it("accepts a router override", () => {
    expect(validateAgentsConfig(testConfig)).toBe(testConfig);
  });

  it("accepts a config without agents: a workflow of actions only (#272)", () => {
    const config: AgentsConfig = { ...testConfig, agents: {} };

    expect(validateAgentsConfig(config).agents).toEqual({});
  });

  it("rejects a negative price", () => {
    const config: AgentsConfigOf<string> = {
      ...testConfig,
      agents: {
        alpha: { ...testConfig.agents.alpha, price: { inputPerMTok: -1, outputPerMTok: 0 } },
      },
    };

    expect(() => validateAgentsConfig(config)).toThrow();
  });

  it("rejects an agent tool the registry does not know", () => {
    const config: AgentsConfigOf<string> = {
      ...testConfig,
      agents: { alpha: { ...testConfig.agents.alpha, tools: ["current_time", "ghost"] } },
    };

    expect(() => validateAgentsConfig(config, ["current_time"])).toThrow(UnknownAgentToolError);
    expect(() => validateAgentsConfig(config, ["current_time"])).toThrow("alpha → ghost");
  });

  it("does not compile a tool name outside the union", () => {
    const agent: AgentsConfigOf<"a", "current_time">["agents"]["a"] = {
      model: "m",
      description: "d",
      price: { inputPerMTok: 0, outputPerMTok: 0 },
      // @ts-expect-error — "ghost" is not a registered tool
      tools: ["ghost"],
    };

    expect(agent.tools).toEqual(["ghost"]);
  });
});
