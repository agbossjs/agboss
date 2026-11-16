/**
 * #1080: a DTO that holds itself, directly or through other DTOs, fails at start with
 * `[dto.cyclic]` naming the component and the cycle — never a RangeError while a schema is built.
 * Every place that walks DTOs: an agent's answer tool, an input, a tool's DTOs; a DTO used twice
 * is not a cycle.
 */
import { describe, expect, it } from "vitest";
import { createAppWith } from "../../../src/application/create-app.js";
import {
  Agent,
  GraphRuleError,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ToolHandler,
} from "../../../src/index.js";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { Reasoning } from "../../../src/models/index.js";
import { start } from "../fixtures/paths.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { workflowOf } from "../../../src/testing/workflow-of.js";
import { applicationWith, workflowWith } from "../../components/fixture/deps-contract.workflow.js";
import type { DtoClass } from "../../../src/dto/types.js";
import { DtoError, Text } from "../../../src/dto/index.js";
import { DiamondDto, PingDto, SelfDto, TreeDto } from "../../dto/fixtures-cycles.js";

const workflowDefaults = {
  defaults: {
    models: { temperature: 0, reasoning: Reasoning.modelDecides(), cache: true },
    router: { model: "typesafe/jev-1.13" },
    tools: { maxToolCalls: 2 },
  },
  uncompactedTurns: 2,
};

const agentWith = (options: Partial<Parameters<typeof Agent>[0]>) => {
  @Agent({ name: "reader-agent", description: "d", model: "test/r", ...options })
  class Reader {}
  return Reader;
};

const cyclicOf = async (error: unknown): Promise<string[]> => {
  expect(error).toBeInstanceOf(GraphRuleError);
  return error instanceof GraphRuleError
    ? error.violations.filter((found) => found.code === "dto.cyclic").map((found) => found.message)
    : [];
};

const failureOf = (build: () => Promise<unknown>): Promise<unknown> =>
  build().then(
    () => undefined,
    (error: unknown) => error,
  );

describe("#1080: an agent's output that holds itself", () => {
  it.each([
    ["itself", SelfDto, "reader-agent: SelfDto → SelfDto"],
    ["itself through another DTO", PingDto, "reader-agent: PingDto → PongDto → PingDto"],
    ["itself through ListOf", TreeDto, "reader-agent: TreeDto → TreeDto"],
  ] as const)(
    "a DTO holding %s: start fails naming the agent and the cycle",
    async (_l, dto, text) => {
      const agent = agentWith({ output: dto });

      const messages = await cyclicOf(
        await failureOf(() => workflowOf(workflowWith("cyc-workflow", {}, agent))),
      );

      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain(text);
    },
  );

  it("createApp refuses it with a rule error, not a RangeError", async () => {
    const agent = agentWith({ output: PingDto });

    const error = await failureOf(() =>
      createAppWith(applicationWith("cyc-workflow", {}, agent), { processEnv: {} }),
    );

    expect(error).toBeInstanceOf(GraphRuleError);
    expect(String(error)).toContain("PingDto → PongDto → PingDto");
  });

  it("a DTO used twice (not a cycle) starts", async () => {
    @WorkflowStart({ name: "diamond-workflow-start", description: "d", input: DiamondDto })
    class DiamondStart {}
    @WorkflowFinish({ name: "diamond-workflow-finish", description: "d", output: DiamondDto })
    class DiamondFinish {}
    @Agent({
      name: "diamond-agent",
      description: "d",
      prompt: "p",
      model: "test/r",
      price: { inputPerMTok: 1, outputPerMTok: 10 },
      input: { diamond: DiamondDto },
      output: DiamondDto,
    })
    class DiamondAgent {}
    @Workflow({
      name: "diamond-workflow",
      version: "1.0.0",
      flow: [
        start(DiamondStart)
          .returns(DiamondDto)
          .toAgent(DiamondAgent)
          .returns(DiamondDto)
          .toFinish(DiamondFinish),
      ],
      ...workflowDefaults,
    })
    class Diamond {}

    await expect(workflowOf(Diamond)).resolves.toBeDefined();
  });
});

describe("#1080: an input that holds itself", () => {
  it("an agent's input DTO", async () => {
    const agent = agentWith({ input: { tree: TreeDto } });

    const messages = await cyclicOf(
      await failureOf(() => workflowOf(workflowWith("cyc-workflow", {}, agent))),
    );

    expect(messages.some((text) => text.includes("TreeDto → TreeDto"))).toBe(true);
  });

  it("an action's input DTO", () => {
    @WorkflowStart({ name: "keep-workflow-start", description: "d", input: SelfDto })
    class KeepStart {}
    @Action({ name: "keep-action", description: "d", input: { tree: SelfDto } })
    class Keep {
      execute(): Promise<void> {
        return Promise.resolve();
      }
    }
    @WorkflowFinish({ name: "keep-workflow-finish", description: "d", output: SelfDto })
    class KeepFinish {}
    @Workflow({
      name: "keep-workflow",
      version: "1.0.0",
      flow: [start(KeepStart).returns(SelfDto).toAction(Keep).toFinish(KeepFinish)],
      ...workflowDefaults,
    })
    class KeepWorkflow {}

    const messages = checkWorkflow(KeepWorkflow)
      .errors.filter((found) => found.code === "dto.cyclic")
      .map((found) => found.message);

    expect(messages).toContain(
      "keep-workflow: keep-action: SelfDto → SelfDto — a DTO cannot reference itself — break the cycle (an id field, or a flat list)",
    );
  });
});

describe("#1080: a tool's DTOs", () => {
  class Query {
    @Text({ prompt: "q" })
    q!: string;
  }

  const toolOf = (input: DtoClass, output: DtoClass) => {
    @Tool({ name: "cyc-tool", description: "d", input, output })
    class CycTool implements ToolHandler<never, never> {
      run(): Promise<never> {
        return Promise.reject(new Error("unused"));
      }
    }
    return CycTool;
  };

  it("an input that holds itself fails at start with a typed DTO error", async () => {
    const agent = agentWith({ tools: [toolOf(PingDto, TreeDto)] });

    const error = await failureOf(() => workflowOf(workflowWith("cyc-workflow", {}, agent)));

    expect(error).toBeInstanceOf(DtoError);
    expect(error).toMatchObject({ code: "dto.cyclic" });
    expect(String(error)).toContain("PingDto → PongDto → PingDto");
  });

  it("an output that holds itself fails the same way", async () => {
    const agent = agentWith({ tools: [toolOf(Query, TreeDto)] });

    const error = await failureOf(() => workflowOf(workflowWith("cyc-workflow", {}, agent)));

    expect(error).toMatchObject({ code: "dto.cyclic" });
    expect(String(error)).toContain("TreeDto → TreeDto");
  });

  it("a tool of plain DTOs starts", async () => {
    const agent = agentWith({ tools: [toolOf(Query, DiamondDto)] });

    await expect(workflowOf(workflowWith("plain-workflow", {}, agent))).resolves.toBeDefined();
  });
});
