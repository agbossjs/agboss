/**
 * #267 PR 1 (AC4, AC6): a channel role's form and the tools it may approve. #659 (AC1): a question
 * role (`ask` / `answer`) is declared again — a flow step asks it; a tool that names it is wrong.
 */
import { ConfigError } from "../../src/core/error-families/config-errors.js";
import { createTestAppWith } from "../../src/testing/create-app-with.js";
import { describe, expect, it } from "vitest";
import { Application } from "../../src/application/application.js";
import { ExternalTask, pauseTargetOf, ToolApproval } from "../../src/channels/pause-targets.js";
import { hours, Ttl } from "../../src/units/index.js";
import { NodeKind } from "../../src/flow/ast.js";
import { declarationOf } from "../../src/flow/decorators/declaration.js";
import { Tool } from "../../src/components/decorators.js";
import { Text } from "../../src/dto/index.js";
import { Agent } from "../../src/flow/decorators/agent.js";
import { Workflow } from "../../src/flow/decorators/workflow.js";
import { inline } from "../../src/index.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { WorkflowStartTextDto } from "../flow/fixtures/dtos.js";
import { onStart } from "../flow/fixtures/paths.js";
import {
  RefundDeskToolApproval,
  RefundCardInputDto,
  RefundCardOutputDto,
  RefundWorkflowFinish,
  RefundWorkflowStart,
  RuleRefundApprovalChannel,
} from "../flow/fixtures/refunds.fixture.js";
import { PauseRespondent } from "../../src/pause/respondent.js";
import { TestModelProvider } from "../../src/testing/test-model-provider.js";

class ChargeInputDto {
  @Text() orderId!: string;
}

class ClarificationQuestionDto {
  @Text() question!: string;
}

class ClarificationAnswerDto {
  @Text() answer!: string;
}

/** A charge tool that names the refund role: its input is not what the role approves. */
@Tool({
  name: "charge-tool",
  description: "Charges",
  input: ChargeInputDto,
  output: RefundCardOutputDto,
  approval: RefundDeskToolApproval,
})
class ChargeTool {
  execute(): Promise<RefundCardOutputDto> {
    return Promise.resolve({ status: "charged" });
  }
}

/** An application over one agent with these tools, the refund role implemented. */
function applicationWith(name: string, tools: readonly (typeof ChargeTool)[]) {
  @Agent({
    name: `${name}-agent`,
    description: "d",
    prompt: inline("p"),
    model: "test/m",
    input: { message: WorkflowStartTextDto },
    output: RefundCardOutputDto,
    tools,
  })
  class ToolAgent {}

  @Workflow({
    name: `${name}-workflow`,
    modelProvider: TestModelProvider,
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    flow: [onStart(RefundWorkflowStart).toAgent(ToolAgent).toFinish(RefundWorkflowFinish)],
    defaults: { router: { model: "typesafe/jev-test" } },
  })
  class ToolWorkflow {}

  @Application({
    name: `${name}-application`,
    version: "1.0.0",
    workflows: [ToolWorkflow],
    budgets: TEST_BUDGETS,
    providers: [RuleRefundApprovalChannel],
  })
  class ToolApplication {}
  return ToolApplication;
}

const assemble = (application: Parameters<typeof createTestAppWith>[0]) =>
  createTestAppWith(application, {
    processEnv: {},
    gateway: createScriptedGateway(new ScriptBook()),
  });

describe("#267 AC6: a tool's input is its approval's input", () => {
  it("wrong tool: a tool whose input is not its approval's input fails assembly", async () => {
    const error: unknown = await assemble(applicationWith("charge", [ChargeTool])).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(ConfigError.GraphRules);
    expect(error).toMatchObject({
      violations: [
        {
          code: "channel.wrong-tool",
          nodes: ["charge-tool", "refund-gate-tool-approval"],
          message: expect.stringContaining("refund-gate-tool-approval approves RefundCardInputDto"),
        },
      ],
    });
  });
});

describe("#659 AC1: an external task is declared, and is its step's node", () => {
  it("an @ExternalTask is its flow node: the step reads its input and gives its output", () => {
    @ExternalTask({
      name: "clarification-external-task",
      description: "Asks the customer to clarify",
      input: ClarificationQuestionDto,
      output: ClarificationAnswerDto,
      respondent: PauseRespondent.Owner,
      timeout: hours(1),
      maxVisits: 2,
    })
    class ClarificationExternalTask {}

    expect(pauseTargetOf(ClarificationExternalTask)?.options).toMatchObject({
      name: "clarification-external-task",
      input: ClarificationQuestionDto,
      output: ClarificationAnswerDto,
    });
    expect(declarationOf(ClarificationExternalTask)).toMatchObject({
      kind: NodeKind.Question,
      options: {
        name: "clarification-external-task",
        input: { ask: ClarificationQuestionDto },
        output: ClarificationAnswerDto,
        maxVisits: 2,
      },
    });
  });

  it("respondent is required: a target without it fails, never defaults to the thread's owner", () => {
    const untyped = ToolApproval as (options: object) => ReturnType<typeof ToolApproval>;
    const declare = (): void => {
      @untyped({
        name: "open-tool-approval",
        description: "d",
        input: RefundCardInputDto,
        timeout: hours(1),
      })
      class OpenToolApproval {}
      expect(OpenToolApproval).toBeDefined();
    };

    expect(declare).toThrow("has no respondent");
  });
});
