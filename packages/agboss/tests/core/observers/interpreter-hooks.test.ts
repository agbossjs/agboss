/**
 * #1343 (#1310): `onChannelInterpreterStart` / `onChannelInterpreterEnd` — told when `app.resume`
 * reads a free-text reply through its role's interpreter, in the paused execution's frame (its
 * waiting step), before the pause is closed: Read with the spend of its model, or Unreadable, the
 * pause staying pending; never the reply, the ask or the pause's id.
 */
import { PauseError } from "../../../src/core/error-families/pause-errors.js";
import { beforeEach, describe, expect } from "vitest";
import {
  Application,
  ChannelInterpreterOutcome,
  Observer,
  type ChannelInterpreterEndEvent,
  type ChannelInterpreterStartEvent,
} from "../../../src/index.js";
import { ToolCallApprovalDecisionDto } from "../../../src/dto/standard/framework.js";
import { callTool, replyWith, testWith } from "../../../src/testing/index.js";
import { usd } from "../../../src/units/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import {
  PayOutTool,
  PayoutReplyInterpreter,
  replyDesk,
  resetReplyDesk,
  TreasurerAgent,
  TreasuryBatchWorkflow,
  TreasuryDeskWorkflow,
  TreasuryPiiPolicy,
  TreasuryWorkflow,
  TreasuryWorkflowStart,
  treasuryChannels,
} from "../../flow/fixtures/replies.fixture.js";
import { execute } from "../../helpers/flow.js";
import { TestModelProvider } from "../../../src/testing/test-model-provider.js";

const events: (ChannelInterpreterStartEvent | ChannelInterpreterEndEvent)[] = [];

@Observer()
class InterpreterWatch {
  onChannelInterpreterStart(event: ChannelInterpreterStartEvent): void {
    events.push(event);
  }

  onChannelInterpreterEnd(event: ChannelInterpreterEndEvent): void {
    events.push(event);
  }
}

const filtered: ChannelInterpreterStartEvent[] = [];

/** Only the other workflow's events: a reading of the treasury workflow's pause is not its own. */
@Observer({ workflows: [TreasuryDeskWorkflow] })
class DeskInterpreterWatch {
  onChannelInterpreterStart(event: ChannelInterpreterStartEvent): void {
    filtered.push(event);
  }
}

@Application({
  name: "watched-treasury-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [TreasuryWorkflow, TreasuryDeskWorkflow, TreasuryBatchWorkflow],
  budgets: TEST_BUDGETS,
  providers: treasuryChannels,
  piiPolicies: [TreasuryPiiPolicy],
  observers: [InterpreterWatch, DeskInterpreterWatch],
})
class WatchedTreasuryApplication {}

const test = testWith(WatchedTreasuryApplication);

beforeEach(() => {
  resetReplyDesk();
  events.length = 0;
  filtered.length = 0;
});

const manager = { actor: { id: "manager-17" } };
const payout = { payee: "ann", amountCents: 1000 };

const pauseId = (): string => {
  const [ask] = replyDesk.asks;
  if (ask === undefined) throw new Error("the desk was not asked");
  return ask.pauseId;
};

describe("#1343: onChannelInterpreterStart / onChannelInterpreterEnd", () => {
  test("a reply the interpreter read: a start and a Read end with its model's cost, in the waiting step", async ({
    app,
    mockModel,
  }) => {
    mockModel(TreasurerAgent).thenReturn(callTool(PayOutTool, payout), replyWith("Paid."));
    mockModel(PayoutReplyInterpreter).thenReturn(
      replyWith(ToolCallApprovalDecisionDto, { approved: true }, { cost: usd(0.004) }),
    );
    await execute(app, TreasuryWorkflowStart, { text: "pay ann $10" });

    await app.resume({ pauseId: pauseId(), reply: "yes, pay it" }, manager);

    expect(events.map((event) => ("outcome" in event ? "end" : "start"))).toEqual(["start", "end"]);
    expect(events[0]).toMatchObject({
      interpreter: "payout-reply-interpreter",
      isCode: false,
      workflow: { name: "treasury-workflow" },
      step: { component: { name: "treasurer-agent" } },
    });
    expect(events[1]).toMatchObject({
      outcome: ChannelInterpreterOutcome.Read,
      costUsd: 0.004,
    });
  });

  test("a reply nobody can read ends Unreadable and the pause stays pending", async ({
    app,
    mockModel,
  }) => {
    mockModel(TreasurerAgent).thenReturn(callTool(PayOutTool, payout));
    mockModel(PayoutReplyInterpreter).thenReturn(replyWith("Unclear.", { cost: usd(0.001) }));
    await execute(app, TreasuryWorkflowStart, { text: "pay ann $10" });

    await expect(app.resume({ pauseId: pauseId(), reply: "hmm" }, manager)).rejects.toBeInstanceOf(
      PauseError.UninterpretableReply,
    );

    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      outcome: ChannelInterpreterOutcome.Unreadable,
      costUsd: 0.001,
    });
  });

  test("an event never shows the reply or the pause's id", async ({ app, mockModel }) => {
    mockModel(TreasurerAgent).thenReturn(callTool(PayOutTool, payout), replyWith("Paid."));
    mockModel(PayoutReplyInterpreter).thenReturn(
      replyWith(ToolCallApprovalDecisionDto, { approved: true }),
    );
    await execute(app, TreasuryWorkflowStart, { text: "pay ann $10" });
    const id = pauseId();

    await app.resume({ pauseId: id, reply: "yes, ann@example.com may be paid" }, manager);

    const shown = JSON.stringify(events);
    expect(shown).not.toContain("ann@example.com");
    expect(shown).not.toContain(id);
  });

  test("the observers are the paused execution's own workflow's: its filter and its mask apply", async ({
    app,
    mockModel,
  }) => {
    mockModel(TreasurerAgent).thenReturn(callTool(PayOutTool, payout), replyWith("Paid."));
    mockModel(PayoutReplyInterpreter).thenReturn(
      replyWith(ToolCallApprovalDecisionDto, { approved: true }),
    );
    await execute(app, TreasuryWorkflowStart, { text: "pay ann $10" });

    await app.resume({ pauseId: pauseId(), reply: "yes" }, manager);

    expect(events).toHaveLength(2);
    // an observer of another workflow hears nothing of this one's pause
    expect(filtered).toEqual([]);
  });
});
