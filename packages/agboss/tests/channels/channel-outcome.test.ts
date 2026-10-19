/** #267 AC5 / AC7 / AC11 (PR 1): what `send` returns decides whether the execution pauses. */
import { describe, expect, it } from "vitest";
import { Application } from "../../src/application/application.js";
import { createApp } from "../../src/application/create-app.js";
import { ChannelOutcome, ChannelOutcomeKind } from "../../src/channels/channel-outcome.js";
import { AutoApproveChannel, AutoRejectChannel } from "../../src/channels/test-channels.js";
import { Channel, Tool, type ToolHandler } from "../../src/components/decorators.js";
import type { Class } from "../../src/components/injection.js";
import { Agent } from "../../src/flow/decorators/agent.js";
import { Workflow } from "../../src/flow/decorators/workflow.js";
import { ExecutionStatus } from "../../src/app/types.js";
import {
  EmptyEnvironment,
  PausedExecutionRepository,
  PauseResolution,
  PauseStatus,
} from "../../src/index.js";
import { callTool, replyWith } from "../../src/testing/index.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { WorkflowStartTextDto } from "../flow/fixtures/dtos.js";
import { start } from "../flow/fixtures/paths.js";
import {
  RefundCardInputDto,
  RefundCardOutputDto,
  RefundCardTool,
  RefundDesk,
  RefundWorkflowFinish,
  RefundWorkflowStart,
  RuleRefundApprovalChannel,
  RuleRefundsApplication,
  SlackRefundsApplication,
} from "../flow/fixtures/refunds.fixture.js";
import { execute } from "../helpers/flow.js";

const offline = (book: ScriptBook) => ({ processEnv: {}, gateway: createScriptedGateway(book) });

/** A refund of `amountCents`, then the clerk's answer. */
function refundScript(amountCents: number): ScriptBook {
  const book = new ScriptBook();
  book
    .scriptOf("agent:refund-clerk-agent")
    .thenReturn(
      callTool(RefundCardTool, { orderId: "A-1", amountCents }),
      replyWith(RefundCardOutputDto, { status: "done" }),
    );
  return book;
}

/** A channel that returns no outcome (a project channel written against the old contract). */
@Channel({ name: "silent-channel" })
class SilentChannel {
  send(): Promise<unknown> {
    return Promise.resolve(undefined);
  }
}

/** A channel that decides with a decision its role's DTO rejects (a refusal that overrides). */
@Channel({ name: "careless-channel" })
class CarelessChannel {
  send(): Promise<unknown> {
    const overrideArguments = { orderId: "A-2", amountCents: 1 };
    return Promise.resolve(ChannelOutcome.decided({ approved: false, overrideArguments }));
  }
}

/** An application whose refund tool names `channel` as is. */
function applicationWith(name: string, channel: Class): Class {
  @Tool({
    name: "refund_card",
    description: "Refunds",
    input: RefundCardInputDto,
    output: RefundCardOutputDto,
    channel,
    deps: [RefundDesk],
  })
  class ChannelRefundTool implements ToolHandler<RefundCardInputDto, RefundCardOutputDto> {
    constructor(private readonly refundDesk: RefundDesk) {}
    run({ orderId }: RefundCardInputDto): Promise<RefundCardOutputDto> {
      this.refundDesk.refunded.push(orderId);
      return Promise.resolve({ status: `refunded ${orderId}` });
    }
  }
  @Agent({
    name: "refund-clerk-agent",
    description: "d",
    prompt: "p",
    model: "test/m",
    input: { message: WorkflowStartTextDto },
    output: RefundCardOutputDto,
    tools: [ChannelRefundTool],
  })
  class ClerkAgent {}
  @Workflow({
    name: `${name}-workflow`,
    version: "1.0.0",
    flow: [
      start(RefundWorkflowStart)
        .returns(WorkflowStartTextDto)
        .toAgent(ClerkAgent)
        .returns(RefundCardOutputDto)
        .toFinish(RefundWorkflowFinish),
    ],
    defaults: { router: { model: "typesafe/jev-test" } },
    providers: [RefundDesk],
  })
  class ChannelWorkflow {}
  @Application({
    name: `${name}-application`,
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [ChannelWorkflow],
    budgets: TEST_BUDGETS,
  })
  class ChannelApplication {}
  return ChannelApplication;
}

/** Runs one refund of `amountCents` on the application: the result and its desk. */
async function refundOn(application: Class, amountCents: number) {
  const book = refundScript(amountCents);
  const app = await createApp(application, offline(book));
  const result = await execute(app, RefundWorkflowStart, { text: "refund A-1" }).catch(
    (error: unknown) => error,
  );
  const desk = app.resolve(RefundDesk);
  return { app, book, result, desk };
}

describe("#267 AC5: awaitReply pauses, decided goes on and leaves no pending record", () => {
  it("awaitReply: the execution pauses and is saved until the reply", async () => {
    const { app, result, desk } = await refundOn(SlackRefundsApplication, 1200);

    expect(result).toMatchObject({
      status: ExecutionStatus.Paused,
      pending: [{ ask: { tool: "refund_card" } }],
    });
    expect(desk.posted).toHaveLength(1);
    expect(desk.refunded).toEqual([]);
    await app.close();
  });

  it("#267 S35 / S107: decided(…) closes the pause it reserved at once — nothing is left waiting", async () => {
    const app = await createApp(RuleRefundsApplication, offline(refundScript(1200)));

    const done = await execute(app, RefundWorkflowStart, { text: "refund A-1" });

    const pauses = app.resolve(PausedExecutionRepository);
    const records = await pauses.findAllByTenantIdAndRootExecutionId("default", done.runId);
    expect(records.map(({ status, resolution }) => ({ status, resolution }))).toEqual([
      { status: PauseStatus.Taken, resolution: PauseResolution.Decided },
    ]);
    await app.close();
  });

  it("decided: a rule-based channel approves at once — no pause, the tool runs", async () => {
    const { app, result, desk } = await refundOn(RuleRefundsApplication, 1200);

    expect(result).toMatchObject({ status: ExecutionStatus.Finished, output: { status: "done" } });
    expect(result).toMatchObject({ pending: [] });
    expect(desk.refunded).toEqual(["A-1"]);
    await app.close();
  });

  it("decided: a refusal at once — no pause, the tool does not run, the agent reads the reason", async () => {
    const { app, book, result, desk } = await refundOn(RuleRefundsApplication, 9000);

    expect(result).toMatchObject({ status: ExecutionStatus.Finished });
    expect(result).toMatchObject({ pending: [] });
    expect(desk.refunded).toEqual([]);
    expect(JSON.stringify(book.scriptOf("agent:refund-clerk-agent").requests.at(-1))).toContain(
      "over $50",
    );
    expect(app.resolve(RuleRefundApprovalChannel)).toBeInstanceOf(RuleRefundApprovalChannel);
    await app.close();
  });

  it("the outcomes: awaitReply and decided(decision)", () => {
    expect(ChannelOutcome.awaitReply()).toEqual({ kind: ChannelOutcomeKind.AwaitReply });
    expect(ChannelOutcome.decided({ approved: true })).toEqual({
      kind: ChannelOutcomeKind.Decided,
      decision: { approved: true },
    });
  });

  it("a channel that returns no outcome fails the step, naming the contract", async () => {
    const { app, result, desk } = await refundOn(applicationWith("silent", SilentChannel), 100);

    expect(String(result)).toContain(
      "channel silent-channel: send() must return ChannelOutcome.awaitReply() or ChannelOutcome.decided(…)",
    );
    expect(desk.refunded).toEqual([]);
    await app.close();
  });
});

describe("#267 AC7 (PR 1 part): a decided decision is validated on the way in", () => {
  it("a decision its DTO rejects fails the step; the tool does not run", async () => {
    const { app, result, desk } = await refundOn(applicationWith("careless", CarelessChannel), 100);

    expect(String(result)).toContain("overrideArguments only with approved: true");
    expect(result).toBeInstanceOf(Error);
    expect(desk.refunded).toEqual([]);
    await app.close();
  });
});

describe("#267 AC11 (PR 1 part): the built-in test channels decide at once", () => {
  it("AutoApproveChannel approves: the tool runs with no pause", async () => {
    const { app, result, desk } = await refundOn(
      applicationWith("approving", AutoApproveChannel),
      100,
    );

    expect(result).toMatchObject({ status: ExecutionStatus.Finished });
    expect(result).toMatchObject({ pending: [] });
    expect(desk.refunded).toEqual(["A-1"]);
    await app.close();
  });

  it("AutoRejectChannel rejects: the tool does not run, no pause", async () => {
    const { app, result, desk } = await refundOn(
      applicationWith("rejecting", AutoRejectChannel),
      100,
    );

    expect(result).toMatchObject({ status: ExecutionStatus.Finished });
    expect(result).toMatchObject({ pending: [] });
    expect(desk.refunded).toEqual([]);
    await app.close();
  });
});
