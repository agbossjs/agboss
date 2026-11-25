import { describe, expect, it } from "vitest";
import { TestWorkflow } from "./fixtures/test-workflow/test.workflow.js";
import { workflowOf } from "../src/testing/workflow-of.js";
import {
  UnknownAgentToolError,
  validateAgentsConfig,
  type AgentsConfig,
  type AgentsConfigOf,
} from "../src/config/types.js";
import { TokenLimit } from "../src/config/types.js";
import { testConfig } from "./helpers.js";
import { usd } from "../src/units/index.js";

describe("validateAgentsConfig", () => {
  it("accepts the shipped config: the default router is served by the workflow's provider, model-max output", async () => {
    const config = validateAgentsConfig((await workflowOf(TestWorkflow)).config);

    expect(config.defaults.router?.kind).toBe("llm");
    expect(config.defaults.models.maxTokens).toBe(TokenLimit.ModelMax);
  });

  it("accepts a router override", () => {
    expect(validateAgentsConfig(testConfig)).toBe(testConfig);
  });

  it("accepts a config without agents: a workflow of actions only (#272)", () => {
    const config: AgentsConfig = { ...testConfig, agents: {} };

    expect(validateAgentsConfig(config).agents).toEqual({});
  });

  it("rejects an agent tool the registry does not know", () => {
    const config: AgentsConfigOf<string> = {
      ...testConfig,
      agents: { alpha: { ...testConfig.agents.alpha, tools: ["current-time-tool", "ghost"] } },
    };

    expect(() => validateAgentsConfig(config, ["current-time-tool"])).toThrow(
      UnknownAgentToolError,
    );
    expect(() => validateAgentsConfig(config, ["current-time-tool"])).toThrow("alpha → ghost");
  });

  it("does not compile a tool name outside the union", () => {
    const agent: AgentsConfigOf<"a", "current-time-tool">["agents"]["a"] = {
      model: "m",
      description: "d",
      // @ts-expect-error — "ghost" is not a registered tool
      tools: ["ghost"],
    };

    expect(agent.tools).toEqual(["ghost"]);
  });
});
