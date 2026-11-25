/** #267 AC9 (PR 1): channel roles are found from the graph; implementations from the application. */
import { createTestAppWith } from "../../src/testing/create-app-with.js";
import { describe, expect, it } from "vitest";
import { Application } from "../../src/application/application.js";
import { channelsOf, channelRuleViolations } from "../../src/channels/channel-rules.js";
import { channelUsesOf } from "../../src/channels/discovery.js";
import { targetNameOf } from "../../src/channels/pause-targets.js";
import { Injectable, Tool } from "../../src/components/decorators.js";
import { Integer } from "../../src/dto/index.js";
import { Agent } from "../../src/flow/decorators/agent.js";
import { Workflow } from "../../src/flow/decorators/workflow.js";
import { EmptyEnvironment, inline, ToolApproval, Ttl } from "../../src/index.js";
import { callTool, replyWith } from "../../src/testing/index.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { WorkflowStartTextDto } from "../flow/fixtures/dtos.js";
import { onStart } from "../flow/fixtures/paths.js";
import {
  CardRefundsWorkflow,
  DoubledRefundsApplication,
  RefundDeskToolApproval,
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
import { ComponentOptions } from "../../src/components/component-options.js";
import { PauseRespondent } from "../../src/pause/respondent.js";
import { days } from "../../src/units/index.js";
import { TestModelProvider } from "../../src/testing/test-model-provider.js";

const offline = (book = new ScriptBook()) => ({
  processEnv: {},
  gateway: createScriptedGateway(book),
});

/** A parent that hands the request to the refunds workflow as a child (#263). */
@Workflow({
  name: "front-desk-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(RefundWorkflowStart).toWorkflow(CardRefundsWorkflow).toFinish(RefundWorkflowFinish),
  ],
})
class FrontDeskWorkflow {}

describe("#267 AC9: roles from the graph", () => {
  it("a tool's channel is found through the tool, children included", () => {
    expect(channelUsesOf([FrontDeskWorkflow])).toEqual([
      {
        tool: "refund-card-tool",
        toolInput: RefundCardInputDto,
        target: RefundDeskToolApproval,
        workflow: "card-refunds-workflow",
      },
    ]);
  });

  it("a child's target needs a channel in the parent's application", () => {
    const uses = channelUsesOf([FrontDeskWorkflow]);

    expect(channelRuleViolations(uses, [], ComponentOptions.none)).toEqual([
      expect.objectContaining({
        code: "channel.missing-for-target",
        nodes: ["refund-gate-tool-approval"],
      }),
    ]);
    expect(
      channelRuleViolations(
        uses,
        [{ owner: "front-desk-application", providers: [SlackRefundApprovalChannel] }],
        ComponentOptions.none,
      ),
    ).toEqual([]);
  });

  it("a target is known by its own name; its channels name it as their target", () => {
    const modules = [{ owner: "a", providers: [SlackRefundApprovalChannel, RefundDesk] }];

    expect(targetNameOf(RefundDeskToolApproval)).toBe("refund-gate-tool-approval");
    expect(channelsOf(RefundDeskToolApproval, modules)).toEqual([SlackRefundApprovalChannel]);
  });

  it("a class that is no pause target cannot be a tool's approval", () => {
    expect(() => targetNameOf(RefundDesk)).toThrow("neither a @ToolApproval nor an @ExternalTask");
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
    const app = await createTestAppWith(SlackRefundsApplication, offline(book));

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
        input: { orderId: "A-1", amountCents: 1200 },
        toolCall: expect.objectContaining({ tool: "refund-card-tool" }),
        expiresAt: expect.any(Date),
        trail: [expect.objectContaining({ action: "opened" })],
      },
    ]);
    expect(desk.tenants).toEqual(["acme"]);
    expect(app.resolve(SlackRefundApprovalChannel)).toBe(app.resolve(RefundDeskToolApproval));
    await app.close();
  });

  it("none listed for a delegate's target → [channel.missing-for-target]", async () => {
    await expect(createTestAppWith(UnprovidedRefundsApplication, offline())).rejects.toMatchObject({
      violations: [
        {
          code: "channel.missing-for-target",
          message: expect.stringContaining(
            "list a @Channel({ target: RefundDeskToolApproval }) class in @Application({ channels })",
          ),
        },
      ],
    });
  });

  it("two listed without a selector → [channel.ambiguous-for-target]", async () => {
    await expect(createTestAppWith(DoubledRefundsApplication, offline())).rejects.toMatchObject({
      violations: [
        {
          code: "channel.ambiguous-for-target",
          message: expect.stringContaining("SlackRefundApprovalChannel, RuleRefundApprovalChannel"),
        },
      ],
    });
  });

  it("a channel is transport: in a workflow's providers it is [di.infrastructure-in-workflow]", async () => {
    @Workflow({
      name: "misplaced-refunds-workflow",
      version: "1.0.0",
      historyTtl: Ttl.Forever,
      flow: [onStart(RefundWorkflowStart).toAgent(RefundClerkAgent).toFinish(RefundWorkflowFinish)],
      defaults: { router: { model: "typesafe/jev-test" } },
      providers: [RefundDesk, RuleRefundApprovalChannel],
    })
    class MisplacedWorkflow {}
    @Application({
      name: "misplaced-application",
      modelProvider: TestModelProvider,
      version: "1.0.0",
      environment: EmptyEnvironment,
      workflows: [MisplacedWorkflow],
      budgets: TEST_BUDGETS,
    })
    class MisplacedApplication {}

    await expect(createTestAppWith(MisplacedApplication, offline())).rejects.toMatchObject({
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

@ToolApproval({
  name: "refund-reply-tool-approval",
  description: "Refunds, replies in free text",
  input: RefundCardInputDto,
  respondent: PauseRespondent.Delegate,
  timeout: days(365),
  channelInterpreter: SharedReplyInterpreter,
})
class RefundReplyToolApproval {}

@ToolApproval({
  name: "limit-tool-approval",
  description: "Limits, replies in free text",
  input: LimitInputDto,
  respondent: PauseRespondent.Delegate,
  timeout: days(365),
  channelInterpreter: SharedReplyInterpreter,
})
class LimitToolApproval {}

@Tool({
  name: "reply-refund-tool",
  description: "d",
  input: RefundCardInputDto,
  output: RefundCardOutputDto,
  approval: RefundReplyToolApproval,
})
class ReplyRefundTool {
  execute(): Promise<RefundCardOutputDto> {
    return Promise.resolve({ status: "refunded" });
  }
}

@Tool({
  name: "raise-limit-tool",
  description: "d",
  input: LimitInputDto,
  output: RefundCardOutputDto,
  approval: LimitToolApproval,
})
class RaiseLimitTool {
  execute(): Promise<RefundCardOutputDto> {
    return Promise.resolve({ status: "raised" });
  }
}

describe("#267 AC8 (PR 1 part): one interpreter belongs to one role", () => {
  it("the same interpreter in two roles → [channel.shared-interpreter]", async () => {
    @Agent({
      name: "replies-agent",
      description: "d",
      prompt: inline("p"),
      model: "test/m",
      input: { message: WorkflowStartTextDto },
      output: RefundCardOutputDto,
      tools: [ReplyRefundTool, RaiseLimitTool],
    })
    class RepliesAgent {}
    @Workflow({
      name: "replies-workflow",
      version: "1.0.0",
      historyTtl: Ttl.Forever,
      flow: [onStart(RefundWorkflowStart).toAgent(RepliesAgent).toFinish(RefundWorkflowFinish)],
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

    await expect(createTestAppWith(RepliesApplication, offline())).rejects.toMatchObject({
      violations: expect.arrayContaining([
        expect.objectContaining({
          code: "channel.shared-interpreter",
          nodes: ["refund-reply-tool-approval", "limit-tool-approval"],
        }),
      ]),
    });
  });
});
