/**
 * #648 — what a chat-model `@ReplyInterpreter` of an approval role is given. AC1: its answer tool
 * describes `overrideArguments` with the approved tool's input fields (every one optional: the
 * fields the reply changes, the rest kept from the call), so "ok but only up to $500" can be an
 * approval with one changed field. AC2: it can say "not understood" through a tool of its own — the
 * pause stays `Pending` and `UninterpretableReplyError` carries its reason, never a refusal.
 */
import { beforeEach, describe, expect } from "vitest";
import { NOT_UNDERSTOOD_TOOL } from "../../src/channels/reply-tools.js";
import {
  ReplyInterpreterNotUnderstoodDto,
  ToolCallApprovalDecisionDto,
} from "../../src/dto/standard/framework.js";
import { PauseStatus, UninterpretableReplyError } from "../../src/index.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import {
  PayOutTool,
  PayoutReplyInterpreter,
  replyDesk,
  resetReplyDesk,
  TreasurerAgent,
  TreasuryApplication,
  TreasuryWorkflowFinish,
  TreasuryWorkflowStart,
  treasuryPauses,
} from "../flow/fixtures/replies.fixture.js";
import { execute } from "../helpers/flow.js";

const test = testWith(TreasuryApplication);

beforeEach(resetReplyDesk);

const manager = { answeredBy: "manager-17" };
const payout = { payee: "ann", amountCents: 1000 };

/** The finance desk's only ask: its pause's id is the reply key. */
function payoutPauseId(): string {
  const [ask] = replyDesk.asks;
  if (ask === undefined) throw new Error("the desk was not asked");
  return ask.pauseId;
}

interface Schema {
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly required?: readonly string[];
  readonly description?: string;
}

describe("#648 AC1: overrideArguments is described by the approved tool's input", () => {
  test("AC1: the answer tool lists the call's fields, none required; a not-understood tool beside it", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(TreasurerAgent).thenReturn(callTool(PayOutTool, payout), replyWith("Not paid."));
    mockLlm(PayoutReplyInterpreter).thenReturn(
      replyWith(ToolCallApprovalDecisionDto, { approved: false, reason: "no" }),
    );
    await execute(app, TreasuryWorkflowStart, { text: "pay ann $10" });
    await app.resume({ pauseId: payoutPauseId(), reply: "no" }, manager);

    const request = mockLlm(PayoutReplyInterpreter).onlyRequest;
    if (request.kind !== "chat") throw new Error("a chat request expected");
    const byName = new Map(request.tools.map((tool) => [tool.function.name, tool.function]));
    expect([...byName.keys()]).toEqual([
      "answer-tool-call-approval-decision-dto",
      NOT_UNDERSTOOD_TOOL,
    ]);
    const answer = byName.get("answer-tool-call-approval-decision-dto")?.parameters as Schema;
    const correction = answer.properties?.overrideArguments;
    expect(Object.keys(correction?.properties ?? {})).toEqual(["amountCents", "payee"]);
    expect(correction?.required).toBeUndefined();
    expect(correction?.description).toContain("keeps the call's own value");
    expect(byName.get(NOT_UNDERSTOOD_TOOL)?.parameters).toMatchObject({ required: ["reason"] });
  });

  test("AC1: a correction of one field runs the call with the others as they were", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(TreasurerAgent).thenReturn(callTool(PayOutTool, payout), replyWith("Paid."));
    mockLlm(PayoutReplyInterpreter)
      .when({ reply: "ok but only up to $5" })
      .thenReturn(
        replyWith(ToolCallApprovalDecisionDto, {
          approved: true,
          overrideArguments: { amountCents: 500 },
        }),
      );
    await execute(app, TreasuryWorkflowStart, { text: "pay ann $10" });

    const done = await app.resume(
      { pauseId: payoutPauseId(), reply: "ok but only up to $5" },
      manager,
    );

    expect(done).toFinishWith(TreasuryWorkflowFinish, { text: "Paid." });
    expect(replyDesk.payouts).toEqual([{ payee: "ann", amountCents: 500 }]);
  });
});

describe("#648 AC2: a model interpreter says 'not understood' through its tool", () => {
  test("AC2: UninterpretableReplyError with its reason; the pause stays pending and is answered later", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(TreasurerAgent).thenReturn(callTool(PayOutTool, payout), replyWith("Paid."));
    mockLlm(PayoutReplyInterpreter)
      .when({ reply: "🤷" })
      .thenReturn(replyWith(ReplyInterpreterNotUnderstoodDto, { reason: "a shrug, no decision" }));
    await execute(app, TreasuryWorkflowStart, { text: "pay ann $10" });

    const failed: unknown = await app
      .resume({ pauseId: payoutPauseId(), reply: "🤷" }, manager)
      .catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(UninterpretableReplyError);
    expect(failed).toHaveProperty(
      "reason",
      "the reply does not answer the question: a shrug, no decision",
    );
    const stored = await treasuryPauses().findByTenantIdAndPauseId("default", payoutPauseId());
    expect(stored?.status).toBe(PauseStatus.Pending);
    expect(replyDesk.payouts).toEqual([]);
    const done = await app.resume(
      { pauseId: payoutPauseId(), decision: { approved: true } },
      manager,
    );
    expect(done).toFinishWith(TreasuryWorkflowFinish, { text: "Paid." });
  });

  test("AC2: the framework's instructions name the tool and say it is not a refusal", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(TreasurerAgent).thenReturn(callTool(PayOutTool, payout));
    mockLlm(PayoutReplyInterpreter).thenReturn(
      replyWith(ReplyInterpreterNotUnderstoodDto, { reason: "unclear" }),
    );
    await execute(app, TreasuryWorkflowStart, { text: "pay ann $10" });
    await app.resume({ pauseId: payoutPauseId(), reply: "hmm" }, manager).catch(() => undefined);

    const request = mockLlm(PayoutReplyInterpreter).onlyRequest;
    expect(request.kind === "chat" && request.system).toContain(
      `call ${NOT_UNDERSTOOD_TOOL} with why; that is not a refusal`,
    );
  });
});
