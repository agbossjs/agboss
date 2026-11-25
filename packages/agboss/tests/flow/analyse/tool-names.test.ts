/**
 * #268 AC9: a project's tool is named like every component — kebab-case ending with `-tool`
 * (no suffix, #1343a),; every name a model sees fits the providers' limit,
 * `[a-zA-Z0-9_-]` up to 64 characters (`[tool.name-too-long]`, `[tool.name-invalid]`); a knowledge
 * base's tool is `search-<rag name>-tool`. All found at assembly, at once, before any model call.
 */
import { ConfigError } from "../../../src/core/error-families/config-errors.js";
import { RagScope } from "../../../src/rag/types.js";
import { RagSource } from "../../../src/rag/rag-source.js";
import { describe, expect, it } from "vitest";
import { Rag } from "../../../src/components/decorators.js";
import { Agent, Tool } from "../../../src/index.js";
import { Text } from "../../../src/dto/index.js";
import type { RagRetrieval } from "../../../src/rag/types.js";
import { workflowOf } from "../../../src/testing/workflow-of.js";
import { workflowWith } from "../../components/fixture/deps-contract.workflow.js";

class Topic {
  @Text({ prompt: "the topic" })
  topic!: string;
}

@Tool({ name: "order_status", description: "The status", input: Topic, output: Topic })
class OrderStatus {
  execute(input: Topic): Promise<Topic> {
    return Promise.resolve(input);
  }
}

/** 65 characters, kebab-case, ending with -tool: one past what a model API accepts. */
const LONG = `${"a".repeat(55)}-long-tool`;

@Tool({ name: LONG, description: "Too long", input: Topic, output: Topic })
class LongTool {
  execute(input: Topic): Promise<Topic> {
    return Promise.resolve(input);
  }
}

const agentWith = (options: Partial<Parameters<typeof Agent>[0]>) => {
  @Agent({ name: "reader-agent", description: "d", model: "test/r", ...options })
  class Reader {}
  return Reader;
};

/** The rules a workflow breaks at assembly, as `{ code, message }`. */
const violationsOf = async (
  workflow: Parameters<typeof workflowOf>[0],
): Promise<readonly { code: string; message: string }[]> => {
  const failed: unknown = await workflowOf(workflow).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failed).toBeInstanceOf(ConfigError.GraphRules);
  const violations = failed instanceof ConfigError.GraphRules ? failed.violations : [];
  return violations.map(({ code, message }) => ({ code, message }));
};

describe("#268 AC9: tool names", () => {
  it("a tool needs no -tool suffix; a name a model refuses is reported", async () => {
    const reader = agentWith({
      tools: [OrderStatus, LongTool],
    });

    expect(await violationsOf(workflowWith("names-workflow", {}, reader))).toEqual([
      {
        code: "tool.name-too-long",
        message: `LongTool: the tool name ${LONG} has 65 characters (at most 64) — give it a shorter name`,
      },
    ]);
  });
});
