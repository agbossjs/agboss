/** #267 AC9 (PR 1): channel roles are found from the graph; implementations from the application. */
import { describe, expect, it } from "vitest";
import { Application } from "../../src/application/application.js";
import { createApp } from "../../src/application/create-app.js";
import { ChannelOf } from "../../src/channels/channel-handler.js";
import { implementationsOf, channelRuleViolations } from "../../src/channels/channel-rules.js";
import { ChannelRole, PauseAnswerer } from "../../src/channels/channel-role.decorator.js";
import { channelNameOf, channelUsesOf } from "../../src/channels/discovery.js";
import { Injectable, Tool, type ToolHandler } from "../../src/components/decorators.js";
import { Integer } from "../../src/dto/index.js";
import { Agent } from "../../src/flow/decorators/agent.js";
import { Workflow } from "../../src/flow/decorators/workflow.js";
import { EmptyEnvironment } from "../../src/index.js";
import { callTool, replyWith } from "../../src/testing/index.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { WorkflowStartTextDto } from "../flow/fixtures/dtos.js";
import { start } from "../flow/fixtures/paths.js";
import {
  CardRefundsWorkflow,
  DoubledRefundsApplication,
  RefundApprovalChannel,
  RefundCardInputDto,
  RefundCardOutputDto,
  RefundCardTool,
  RefundClerkAgent,
  RefundDesk,
  RefundWorkflowFinish,
  RefundWorkflowStart,
  RuleRefundApprovalChannel,
  SlackRefundApprovalChannel,
  SlackRefundsApplication,
  UnprovidedRefundsApplication,
} from "../flow/fixtures/refunds.fixture.js";
import { execute } from "../helpers/flow.js";

const offline = (book = new ScriptBook()) => ({
  processEnv: {},
  gateway: createScriptedGateway(book),
});

/** A parent that hands the request to the refunds workflow as a child (#263). */
@Workflow({
  name: "front-desk-workflow",
  version: "1.0.0",
  flow: [
    start(RefundWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toWorkflow(CardRefundsWorkflow)
      .returns(RefundCardOutputDto)
      .toFinish(RefundWorkflowFinish),
  ],
})
class FrontDeskWorkflow {}

describe("#267 AC9: roles from the graph", () => {
  it("a tool's channel is found through the tool, children included", () => {
    expect(channelUsesOf([FrontDeskWorkflow])).toEqual([
      {
        tool: "refund-card-tool",
        toolInput: RefundCardInputDto,
        channel: RefundApprovalChannel,
        workflow: "card-refunds-workflow",
      },
    ]);
  });

  it("a child's role needs an implementation in the parent's application", () => {
    const uses = channelUsesOf([FrontDeskWorkflow]);

    expect(channelRuleViolations(uses, [])).toEqual([
      expect.objectContaining({
        code: "di.missing-implementation",
        nodes: ["refund-approval-channel"],
      }),
    ]);
    expect(
      channelRuleViolations(uses, [
        { owner: "front-desk-application", providers: [SlackRefundApprovalChannel] },
      ]),
    ).toEqual([]);
  });

  it("a role is known by its own name; its implementations extend it", () => {
    const modules = [{ owner: "a", providers: [SlackRefundApprovalChannel, RefundDesk] }];

    expect(channelNameOf(RefundApprovalChannel)).toBe("refund-approval-channel");
    expect(channelNameOf(SlackRefundApprovalChannel)).toBe("slack-refund-approval-channel");
    expect(implementationsOf(RefundApprovalChannel, modules)).toEqual([SlackRefundApprovalChannel]);
  });

  it("a class that is neither a channel nor a role cannot be a tool's channel", () => {
    expect(() => channelNameOf(RefundDesk)).toThrow("neither a @Channel nor a @ChannelRole");
  });
});

describe("#267 AC9: implementations in @Application({ providers })", () => {
  it("the implementation the application lists is the tool's channel", async () => {
    const book = new ScriptBook();
    book
      .scriptOf("agent:refund-clerk-agent")
      .thenReturn(
        callTool(RefundCardTool, { orderId: "A-1", amountCents: 1200 }),
        replyWith(RefundCardOutputDto, { status: "asked" }),
      );
    const app = await createApp(SlackRefundsApplication, offline(book));

    await execute(
      app,
      RefundWorkflowStart,
      { text: "refund A-1" },
      { tenant: { tenantId: "acme" } },
    );

    const desk = app.resolve(RefundDesk);
    expect(desk.posted).toEqual([
      {
        pauseId: expect.stringMatching(/^[0-9a-f]{32}$/),
        value: expect.objectContaining({ arguments: { orderId: "A-1", amountCents: 1200 } }),
      },
    ]);
    expect(desk.tenants).toEqual(["acme"]);
    expect(app.resolve(RefundApprovalChannel)).toBe(app.resolve(SlackRefundApprovalChannel));
    await app.close();
  });

  it("none listed → [di.missing-implementation]", async () => {
    await expect(createApp(UnprovidedRefundsApplication, offline())).rejects.toMatchObject({
      violations: [
        {
          code: "di.missing-implementation",
          message: expect.stringContaining(
            "list a @Channel class that extends RefundApprovalChannel in @Application({ providers })",
          ),
        },
      ],
    });
  });

  it("two listed → [di.ambiguous-implementation]", async () => {
    await expect(createApp(DoubledRefundsApplication, offline())).rejects.toMatchObject({
      violations: [
        {
          code: "di.ambiguous-implementation",
          message: expect.stringContaining("SlackRefundApprovalChannel, RuleRefundApprovalChannel"),
        },
      ],
    });
  });

  it("a channel is transport: in a workflow's providers it is [di.infrastructure-in-workflow]", async () => {
    @Workflow({
      name: "misplaced-refunds-workflow",
      version: "1.0.0",
      flow: [
        start(RefundWorkflowStart)
          .returns(WorkflowStartTextDto)
          .toAgent(RefundClerkAgent)
          .returns(RefundCardOutputDto)
          .toFinish(RefundWorkflowFinish),
      ],
      defaults: { router: { model: "typesafe/jev-test" } },
      providers: [RefundDesk, RuleRefundApprovalChannel],
    })
    class MisplacedWorkflow {}
    @Application({
      name: "misplaced-application",
      version: "1.0.0",
      environment: EmptyEnvironment,
      workflows: [MisplacedWorkflow],
      budgets: TEST_BUDGETS,
    })
    class MisplacedApplication {}

    await expect(createApp(MisplacedApplication, offline())).rejects.toMatchObject({
      violations: expect.arrayContaining([
        expect.objectContaining({
          code: "di.infrastructure-in-workflow",
          message: expect.stringContaining("RuleRefundApprovalChannel is a @Channel"),
        }),
      ]),
    });
  });
});

@Injectable()
class SharedReplyInterpreter {}

class LimitInputDto {
  @Integer({ min: 1 }) amountCents!: number;
}

@ChannelRole({
  name: "refund-reply-channel",
  description: "Refunds, replies in free text",
  approves: RefundCardInputDto,
  answeredBy: PauseAnswerer.Channel,
  replyInterpreter: SharedReplyInterpreter,
})
abstract class RefundReplyChannel extends ChannelOf<RefundReplyChannel> {}

@ChannelRole({
  name: "limit-reply-channel",
  description: "Limits, replies in free text",
  approves: LimitInputDto,
  answeredBy: PauseAnswerer.Channel,
  replyInterpreter: SharedReplyInterpreter,
})
abstract class LimitReplyChannel extends ChannelOf<LimitReplyChannel> {}

@Tool({
  name: "reply-refund-tool",
  description: "d",
  input: RefundCardInputDto,
  output: RefundCardOutputDto,
  channel: RefundReplyChannel,
})
class ReplyRefundTool implements ToolHandler<RefundCardInputDto, RefundCardOutputDto> {
  run(): Promise<RefundCardOutputDto> {
    return Promise.resolve({ status: "refunded" });
  }
}

@Tool({
  name: "raise-limit-tool",
  description: "d",
  input: LimitInputDto,
  output: RefundCardOutputDto,
  channel: LimitReplyChannel,
})
class RaiseLimitTool implements ToolHandler<LimitInputDto, RefundCardOutputDto> {
  run(): Promise<RefundCardOutputDto> {
    return Promise.resolve({ status: "raised" });
  }
}

describe("#267 AC8 (PR 1 part): one interpreter belongs to one role", () => {
  it("the same interpreter in two roles → [channel.shared-interpreter]", async () => {
    @Agent({
      name: "replies-agent",
      description: "d",
      prompt: "p",
      model: "test/m",
      input: { message: WorkflowStartTextDto },
      output: RefundCardOutputDto,
      tools: [ReplyRefundTool, RaiseLimitTool],
    })
    class RepliesAgent {}
    @Workflow({
      name: "replies-workflow",
      version: "1.0.0",
      flow: [
        start(RefundWorkflowStart)
          .returns(WorkflowStartTextDto)
          .toAgent(RepliesAgent)
          .returns(RefundCardOutputDto)
          .toFinish(RefundWorkflowFinish),
      ],
      defaults: { router: { model: "typesafe/jev-test" } },
    })
    class RepliesWorkflow {}
    @Application({
      name: "replies-application",
      version: "1.0.0",
      environment: EmptyEnvironment,
      workflows: [RepliesWorkflow],
      budgets: TEST_BUDGETS,
    })
    class RepliesApplication {}

    await expect(createApp(RepliesApplication, offline())).rejects.toMatchObject({
      violations: expect.arrayContaining([
        expect.objectContaining({
          code: "channel.shared-interpreter",
          nodes: ["refund-reply-channel", "limit-reply-channel"],
        }),
      ]),
    });
  });
});
