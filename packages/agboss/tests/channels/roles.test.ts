/** #267 PR 1 (AC4, AC6): a channel role's form and the tools it may approve. */
import { describe, expect, it } from "vitest";
import { Application } from "../../src/application/application.js";
import { createApp } from "../../src/application/create-app.js";
import { ChannelOf } from "../../src/channels/channel-handler.js";
import { ChannelRole, PauseAnswerer } from "../../src/channels/channel-role.decorator.js";
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

@ChannelRole({
  name: "clarification-channel",
  description: "Asks the customer to clarify",
  ask: ClarificationQuestionDto,
  answer: ClarificationAnswerDto,
  answeredBy: PauseAnswerer.ThreadOwner,
})
abstract class ClarificationChannel extends ChannelOf<ClarificationChannel> {}

/** A charge tool that names the refund role: its input is not what the role approves. */
@Tool({
  name: "charge",
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

/** A refund tool that names a question role: a question approves no tool. */
@Tool({
  name: "ask_refund",
  description: "Refunds",
  input: RefundCardInputDto,
  output: RefundCardOutputDto,
  channel: ClarificationChannel,
})
class AskRefundTool implements ToolHandler<RefundCardInputDto, RefundCardOutputDto> {
  run(): Promise<RefundCardOutputDto> {
    return Promise.resolve({ status: "refunded" });
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

const assemble = (application: Parameters<typeof createApp>[0]) =>
  createApp(application, { processEnv: {}, gateway: createScriptedGateway(new ScriptBook()) });

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
          nodes: ["charge", "refund-approval-channel"],
          message: expect.stringContaining("refund-approval-channel approves RefundCardInputDto"),
        },
      ],
    });
  });

  it("wrong tool: a question role (ask / answer) approves no tool", async () => {
    const error: unknown = await assemble(applicationWith("ask", [AskRefundTool])).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toMatchObject({
      violations: [
        {
          code: "channel.wrong-tool",
          message: expect.stringContaining("clarification-channel asks a question"),
        },
        { code: "di.missing-implementation", nodes: ["clarification-channel"] },
      ],
    });
  });
});

describe("#267 AC4 / AC6: the role's form, checked when it is declared", () => {
  // what an untyped (JS) caller may pass: the compiler rejects these forms (channels.test-d.ts)
  const untypedChannelRole = ChannelRole as (options: object) => ReturnType<typeof ChannelRole>;
  const declare =
    (options: object): (() => void) =>
    () => {
      @untypedChannelRole(options)
      abstract class SomeChannel extends ChannelOf<SomeChannel> {}
      expect(SomeChannel).toBeDefined();
    };

  it("both forms together fail: approves and ask / answer", () => {
    const both = {
      name: "both-channel",
      description: "d",
      approves: RefundCardInputDto,
      ask: ClarificationQuestionDto,
      answer: ClarificationAnswerDto,
      answeredBy: PauseAnswerer.Channel,
    };

    expect(declare(both)).toThrow(
      new ComponentError(
        '[channel.role-form] @ChannelRole "both-channel" (SomeChannel) declares both approves and ask / answer — keep one form',
      ),
    );
  });

  it("neither form fails: an ask without its answer", () => {
    const half = {
      name: "half-channel",
      description: "d",
      ask: ClarificationQuestionDto,
      answeredBy: PauseAnswerer.ThreadOwner,
    };

    expect(declare(half)).toThrow("declares neither approves nor both ask and answer");
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
