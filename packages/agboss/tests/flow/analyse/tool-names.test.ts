/**
 * #268 AC9: a project's tool is named like every component — kebab-case ending with `-tool`
 * (`[name.kind-suffix]`), `@McpTool` too; every name a model sees fits the providers' limit,
 * `[a-zA-Z0-9_-]` up to 64 characters (`[tool.name-too-long]`, `[tool.name-invalid]`); a knowledge
 * base's tool is `search-<rag name>-tool`. All found at assembly, at once, before any model call.
 */
import { describe, expect, it } from "vitest";
import { Rag } from "../../../src/components/decorators.js";
import { Agent, RagMode, Tool, type ToolHandler } from "../../../src/index.js";
import { Text } from "../../../src/dto/index.js";
import { GraphRuleError } from "../../../src/graph/rule-error.js";
import type { RagRetrieval } from "../../../src/rag/types.js";
import { workflowOf } from "../../../src/testing/index.js";
import { workflowWith } from "../../components/fixture/deps-contract.workflow.js";

class Topic {
  @Text({ prompt: "the topic" })
  topic!: string;
}

@Tool({ name: "order_status", description: "The status", input: Topic, output: Topic })
class OrderStatus implements ToolHandler<Topic, Topic> {
  run(input: Topic): Promise<Topic> {
    return Promise.resolve(input);
  }
}

/** 65 characters, kebab-case, ending with -tool: one past what a model API accepts. */
const LONG = `${"a".repeat(55)}-long-tool`;

@Tool({ name: LONG, description: "Too long", input: Topic, output: Topic })
class LongTool implements ToolHandler<Topic, Topic> {
  run(input: Topic): Promise<Topic> {
    return Promise.resolve(input);
  }
}

@Rag({ name: "jobs-rag", description: "Jobs", topK: 1 })
class JobsRag {
  retrieve(): Promise<RagRetrieval> {
    return Promise.resolve({ results: [] });
  }
}

@Rag({ name: "notes.v2", description: "Notes", topK: 1 })
class DottedRag {
  retrieve(): Promise<RagRetrieval> {
    return Promise.resolve({ results: [] });
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
  expect(failed).toBeInstanceOf(GraphRuleError);
  const violations = failed instanceof GraphRuleError ? failed.violations : [];
  return violations.map(({ code, message }) => ({ code, message }));
};

describe("#268 AC9: tool names", () => {
  it("a tool not in kebab-case ending with -tool, and a name a model refuses — all at once", async () => {
    const reader = agentWith({
      tools: [OrderStatus, LongTool],
      rag: [{ use: DottedRag, mode: RagMode.Tool }],
    });

    expect(await violationsOf(workflowWith("names-workflow", {}, reader))).toEqual([
      {
        code: "name.kind-suffix",
        message: 'OrderStatus: "order_status" on @Tool — name it "order-status-tool"',
      },
      {
        code: "tool.name-too-long",
        message: `LongTool: the tool name ${LONG} has 65 characters (at most 64) — give it a shorter name`,
      },
      {
        code: "tool.name-invalid",
        message:
          'DottedRag: the tool name "search-notes.v2-tool" has characters a model API refuses — letters, digits, "_" and "-" only',
      },
    ]);
  });

  it("a knowledge base's tool is search-<rag name>-tool", async () => {
    const reader = agentWith({ rag: [{ use: JobsRag, mode: RagMode.Tool }] });

    const bundle = await workflowOf(workflowWith("jobs-workflow", {}, reader));

    expect(bundle.config.agents["reader-agent"]?.tools).toEqual(["search-jobs-rag-tool"]);
  });
});
