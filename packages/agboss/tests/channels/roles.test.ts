/**
 * #267 PR 1 (AC4, AC6): a channel role's form and the tools it may approve. #659 (AC1): a question
 * role (`ask` / `answer`) is declared again — a flow step asks it; a tool that names it is wrong.
 */
import { createAppWith } from "../../src/application/create-app.js";
import { describe, expect, it } from "vitest";
import { Application } from "../../src/application/application.js";
import { ChannelOf } from "../../src/channels/channel-handler.js";
import {
  ChannelRole,
  channelRoleOptionsOf,
  PauseAnswerer,
} from "../../src/channels/channel-role.decorator.js";
import { NodeKind } from "../../src/flow/ast.js";
import { declarationOf } from "../../src/flow/decorators/declaration.js";
import { Tool, type ToolHandler } from "../../src/components/decorators.js";
import { ComponentError } from "../../src/components/metadata.js";
import { Text } from "../../src/dto/index.js";
import { Agent } from "../../src/flow/decorators/agent.js";
import { Workflow } from "../../src/flow/decorators/workflow.js";
import { GraphRuleError } from "../../src/graph/rule-error.js";
import { EmptyEnvironment } from "../../src/index.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { WorkflowStartTextDto } from "../flow/fixtures/dtos.js";
import { start } from "../flow/fixtures/paths.js";
import {
  RefundApprovalChannel,
  RefundCardInputDto,
  RefundCardOutputDto,
  RefundWorkflowFinish,
  RefundWorkflowStart,
  RuleRefundApprovalChannel,
} from "../flow/fixtures/refunds.fixture.js";

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
  channel: RefundApprovalChannel,
})
class ChargeTool implements ToolHandler<ChargeInputDto, RefundCardOutputDto> {
  run(): Promise<RefundCardOutputDto> {
    return Promise.resolve({ status: "charged" });
  }
}

/** An application over one agent with these tools, the refund role implemented. */
function applicationWith(name: string, tools: readonly (typeof ChargeTool)[]) {
  @Agent({
    name: `${name}-agent`,
    description: "d",
    prompt: "p",
    model: "test/m",
    input: { message: WorkflowStartTextDto },
    output: RefundCardOutputDto,
    tools,
  })
  class ToolAgent {}

  @Workflow({
    name: `${name}-workflow`,
    version: "1.0.0",
    flow: [
      start(RefundWorkflowStart)
        .returns(WorkflowStartTextDto)
        .toAgent(ToolAgent)
        .returns(RefundCardOutputDto)
        .toFinish(RefundWorkflowFinish),
    ],
    defaults: { router: { model: "typesafe/jev-test" } },
  })
  class ToolWorkflow {}

  @Application({
    name: `${name}-application`,
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [ToolWorkflow],
    budgets: TEST_BUDGETS,
    providers: [RuleRefundApprovalChannel],
  })
  class ToolApplication {}
  return ToolApplication;
}

const assemble = (application: Parameters<typeof createAppWith>[0]) =>
  createAppWith(application, { processEnv: {}, gateway: createScriptedGateway(new ScriptBook()) });

describe("#267 AC6: a tool's input is its role's approves", () => {
  it("wrong tool: a tool whose input is not the role's approves fails assembly", async () => {
    const error: unknown = await assemble(applicationWith("charge", [ChargeTool])).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(GraphRuleError);
    expect(error).toMatchObject({
      violations: [
        {
          code: "channel.wrong-tool",
          nodes: ["charge-tool", "refund-approval-channel"],
          message: expect.stringContaining("refund-approval-channel approves RefundCardInputDto"),
        },
      ],
    });
  });
});

describe("#267 AC4 / AC6, #647: the role's form, checked when it is declared", () => {
  // what an untyped (JS) caller may pass: the compiler rejects these forms (channels.test-d.ts)
  const untypedChannelRole = ChannelRole as (options: object) => ReturnType<typeof ChannelRole>;
  const declare =
    (options: object): (() => void) =>
    () => {
      @untypedChannelRole(options)
      abstract class SomeChannel extends ChannelOf<SomeChannel> {}
      expect(SomeChannel).toBeDefined();
    };

  it("#659 AC1: a question role (ask / answer) is declared, and is its step's node", () => {
    const question = {
      name: "clarification-question",
      description: "Asks the customer to clarify",
      ask: ClarificationQuestionDto,
      answer: ClarificationAnswerDto,
      answeredBy: PauseAnswerer.ThreadOwner,
      maxVisits: 2,
    };
    @ChannelRole(question)
    abstract class ClarificationQuestion extends ChannelOf<ClarificationQuestion> {}

    expect(channelRoleOptionsOf(ClarificationQuestion)).toEqual(question);
    expect(declarationOf(ClarificationQuestion)).toMatchObject({
      kind: NodeKind.Question,
      options: {
        name: "clarification-question",
        input: { ask: ClarificationQuestionDto },
        output: ClarificationAnswerDto,
        maxVisits: 2,
      },
    });
  });

  it("#659 AC1: both forms, or half a question, fail: [channel.role-form]", () => {
    const role = { name: "both-question", description: "d", answeredBy: PauseAnswerer.Channel };

    expect(
      declare({ ...role, approves: RefundCardInputDto, ask: ClarificationQuestionDto }),
    ).toThrow(
      new ComponentError({
        message:
          '[channel.role-form] @ChannelRole "both-question" (SomeChannel) declares both approves and ask / answer — keep one form',
      }),
    );
    expect(declare({ ...role, answer: ClarificationAnswerDto })).toThrow(
      "declares neither approves nor both ask and answer",
    );
    expect(declare({ ...role, ask: ClarificationQuestionDto })).toThrow("[channel.role-form]");
  });

  it("a role without approves or ask / answer fails", () => {
    const empty = { name: "empty-channel", description: "d", answeredBy: PauseAnswerer.Channel };

    expect(declare(empty)).toThrow("[channel.role-form]");
    expect(declare(empty)).toThrow("declares neither approves nor both ask and answer");
  });

  it("answeredBy is required: a role without it fails, never defaults to the thread's owner", () => {
    const open = {
      name: "open-channel",
      description: "d",
      approves: RefundCardInputDto,
    };

    expect(declare(open)).toThrow("has no answeredBy");
  });
});
