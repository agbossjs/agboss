/**
 * #688 — a capped approval through a chat-model reply interpreter, offline. The framework's
 * instructions say what a limit is — an approval with the field set to it, in any language — when it
 * leaves the call as it is, and what stays not understood (no yes or no, a guess, a limit that would
 * need converting); the tool descriptions say the same. What the model gives is laid over the call
 * and validated like a decision: a capped approval after a reply not understood on the same pause
 * runs the call capped, and an answer that does not validate — the cap as text, below the field's
 * minimum, a correction on a refusal, an answer beside a not understood — is no approval: the pause
 * stays pending and nothing runs.
 */
import { beforeEach, describe, expect } from "vitest";
import {
  DECISION_DESCRIPTION,
  NOT_UNDERSTOOD_DESCRIPTION,
  ReplyDecision,
  NOT_UNDERSTOOD_TOOL,
  OVERRIDE_ARGUMENTS_DESCRIPTION,
} from "../../src/channels/reply-tools.js";
import {
  ReplyInterpreterNotUnderstoodDto,
  ToolCallApprovalDecisionDto,
} from "../../src/dto/standard/framework.js";
import { PauseStatus, UninterpretableReplyError } from "../../src/index.js";
import { callTool, callTools, replyWith, testWith } from "../../src/testing/index.js";
import type { ToolCallTurn } from "../../src/testing/turns.js";
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
const payout = { payee: "ann", amountCents: 120_000 };
const ANSWER_TOOL = "answer-tool-call-approval-decision-dto";

function payoutPauseId(): string {
  const [ask] = replyDesk.asks;
  if (ask === undefined) throw new Error("the desk was not asked");
  return ask.pauseId;
}

/** The interpreter's answer as a raw move: what a model may send, valid or not. */
const answered = (args: Readonly<Record<string, unknown>>): ToolCallTurn => ({
  kind: "tool-call",
  tool: ANSWER_TOOL,
  args,
});

describe("#688: the framework's texts say what a capped approval is", () => {
  test("the instructions: a limit is an approval in any language, ambiguity and converting are not understood", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(TreasurerAgent).thenReturn(callTool(PayOutTool, payout));
    mockLlm(PayoutReplyInterpreter).thenReturn(
      replyWith(ReplyInterpreterNotUnderstoodDto, { reason: "unclear" }),
    );
    await execute(app, TreasuryWorkflowStart, { text: "pay ann $1200" });
    await app.resume({ pauseId: payoutPauseId(), reply: "hmm" }, manager).catch(() => undefined);

    const request = mockLlm(PayoutReplyInterpreter).onlyRequest;
    if (request.kind !== "chat") throw new Error("a chat request expected");
    const { system } = request;
    expect(system).toContain("in any language");
    expect(system).toContain('"yes, up to $900"');
    expect(system).toContain("approve with the amount set to 900 — a limit is never a refusal");
    expect(system).toContain("never raise an amount up to a limit");
    expect(system).toContain("a no is never unclear");
    expect(system).toContain("would need converting");
    expect(system).toContain(`call ${NOT_UNDERSTOOD_TOOL} with why; that is not a refusal`);
    const byName = new Map(request.tools.map((tool) => [tool.function.name, tool.function]));
    expect(byName.get(NOT_UNDERSTOOD_TOOL)?.description).toBe(NOT_UNDERSTOOD_DESCRIPTION);
    expect(NOT_UNDERSTOOD_DESCRIPTION).toContain("A yes with a limit is an approval, never this.");
    // three named decisions in place of a boolean a cheap model reads "a limit below" into
    const parameters = byName.get(ANSWER_TOOL)?.parameters as {
      readonly properties: Readonly<
        Record<string, { readonly enum?: readonly string[]; readonly description?: string }>
      >;
      readonly required: readonly string[];
    };
    expect(parameters.required).toEqual(["decision"]);
    expect(parameters.properties.approved).toBeUndefined();
    expect(parameters.properties.decision?.enum).toEqual([
      ReplyDecision.Approve,
      ReplyDecision.ApproveWithChanges,
      ReplyDecision.Refuse,
    ]);
    expect(parameters.properties.decision?.description).toBe(DECISION_DESCRIPTION);
    expect(parameters.properties.overrideArguments?.description).toBe(
      OVERRIDE_ARGUMENTS_DESCRIPTION,
    );
    expect(OVERRIDE_ARGUMENTS_DESCRIPTION).toContain("in the units of the call's own arguments");
  });
});

describe("#688: a capped approval after a reply not understood", () => {
  test("'🤷' stays pending; 'yes, up to $900' on the same pause pays $900, the payee kept", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(TreasurerAgent).thenReturn(callTool(PayOutTool, payout), replyWith("Paid."));
    mockLlm(PayoutReplyInterpreter)
      .when({ reply: "🤷" })
      .thenReturn(replyWith(ReplyInterpreterNotUnderstoodDto, { reason: "a shrug" }));
    mockLlm(PayoutReplyInterpreter)
      .when({ reply: "yes, up to $900" })
      .thenReturn(
        replyWith(ToolCallApprovalDecisionDto, {
          approved: true,
          overrideArguments: { amountCents: 90_000 },
        }),
      );
    await execute(app, TreasuryWorkflowStart, { text: "pay ann $1200" });
    const pauseId = payoutPauseId();
    const shrug = await app.resume({ pauseId, reply: "🤷" }, manager).catch((e: unknown) => e);
    expect(shrug).toBeInstanceOf(UninterpretableReplyError);

    const done = await app.resume({ pauseId, reply: "yes, up to $900" }, manager);

    expect(done).toFinishWith(TreasuryWorkflowFinish, { text: "Paid." });
    expect(replyDesk.payouts).toEqual([{ payee: "ann", amountCents: 90_000 }]);
  });
});

describe("#688: an answer that does not validate is no approval", () => {
  for (const [what, args] of [
    ["the cap as text", { approved: true, overrideArguments: { amountCents: "90000" } }],
    ["a cap below the field's minimum", { approved: true, overrideArguments: { amountCents: 0 } }],
    [
      "a cap that is no whole number",
      { approved: true, overrideArguments: { amountCents: 900.5 } },
    ],
    ["a correction on a refusal", { approved: false, overrideArguments: { amountCents: 90_000 } }],
    ["no approved at all", { overrideArguments: { amountCents: 90_000 } }],
  ] as const)
    test(`${what}: UninterpretableReplyError, the pause pending, nothing paid`, async ({
      app,
      mockLlm,
    }) => {
      mockLlm(TreasurerAgent).thenReturn(callTool(PayOutTool, payout));
      mockLlm(PayoutReplyInterpreter).thenReturn(answered(args));
      await execute(app, TreasuryWorkflowStart, { text: "pay ann $1200" });

      const failed = await app
        .resume({ pauseId: payoutPauseId(), reply: "yes, up to $900" }, manager)
        .catch((error: unknown) => error);

      expect(failed).toBeInstanceOf(UninterpretableReplyError);
      const stored = await treasuryPauses().findByTenantIdAndPauseId("default", payoutPauseId());
      expect(stored?.status).toBe(PauseStatus.Pending);
      expect(replyDesk.payouts).toEqual([]);
    });

  test("an approval beside a not understood in one move: not understood wins, nothing paid", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(TreasurerAgent).thenReturn(callTool(PayOutTool, payout));
    mockLlm(PayoutReplyInterpreter).thenReturn(
      callTools(answered({ approved: true, overrideArguments: { amountCents: 90_000 } }), {
        kind: "tool-call",
        tool: NOT_UNDERSTOOD_TOOL,
        args: { reason: "which currency?" },
      }),
    );
    await execute(app, TreasuryWorkflowStart, { text: "pay ann $1200" });

    const failed = await app
      .resume({ pauseId: payoutPauseId(), reply: "yes, up to 900" }, manager)
      .catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(UninterpretableReplyError);
    expect(failed).toHaveProperty("reason", expect.stringContaining("which currency?"));
    expect(replyDesk.payouts).toEqual([]);
  });
});

describe("#688: the model's named decision is the role's answer", () => {
  for (const [what, args, paid] of [
    [
      "approve-with-changes: the call capped, the payee kept",
      { decision: "approve-with-changes", overrideArguments: { amountCents: 90_000 } },
      [{ payee: "ann", amountCents: 90_000 }],
    ],
    [
      "approve: the call as asked — a correction beside it dropped, never a raise",
      { decision: "approve", overrideArguments: { amountCents: 200_000 } },
      [{ payee: "ann", amountCents: 120_000 }],
    ],
  ] as const)
    test(what, async ({ app, mockLlm }) => {
      mockLlm(TreasurerAgent).thenReturn(callTool(PayOutTool, payout), replyWith("Paid."));
      mockLlm(PayoutReplyInterpreter).thenReturn(answered(args));
      await execute(app, TreasuryWorkflowStart, { text: "pay ann $1200" });

      const done = await app.resume({ pauseId: payoutPauseId(), reply: "yes" }, manager);

      expect(done).toFinishWith(TreasuryWorkflowFinish, { text: "Paid." });
      expect(replyDesk.payouts).toEqual(paid);
    });

  test("refuse: the call refused with the reason, nothing paid", async ({ app, mockLlm }) => {
    mockLlm(TreasurerAgent).thenReturn(callTool(PayOutTool, payout), replyWith("Not paid."));
    mockLlm(PayoutReplyInterpreter).thenReturn(
      answered({ decision: "refuse", reason: "no budget" }),
    );
    await execute(app, TreasuryWorkflowStart, { text: "pay ann $1200" });

    const done = await app.resume({ pauseId: payoutPauseId(), reply: "no, no budget" }, manager);

    expect(done).toFinishWith(TreasuryWorkflowFinish, { text: "Not paid." });
    expect(replyDesk.payouts).toEqual([]);
  });

  for (const [what, args] of [
    ["approve-with-changes that changes nothing", { decision: "approve-with-changes" }],
    ["a decision no role has", { decision: "maybe" }],
    [
      "a raise read from the reply",
      { decision: "approve-with-changes", overrideArguments: { amountCents: 200_000 } },
    ],
  ] as const)
    test(`${what}: UninterpretableReplyError, the pause pending, nothing paid`, async ({
      app,
      mockLlm,
    }) => {
      mockLlm(TreasurerAgent).thenReturn(callTool(PayOutTool, payout));
      mockLlm(PayoutReplyInterpreter).thenReturn(answered(args));
      await execute(app, TreasuryWorkflowStart, { text: "pay ann $1200" });

      const failed = await app
        .resume({ pauseId: payoutPauseId(), reply: "yes, up to $2000" }, manager)
        .catch((error: unknown) => error);

      expect(failed).toBeInstanceOf(UninterpretableReplyError);
      const stored = await treasuryPauses().findByTenantIdAndPauseId("default", payoutPauseId());
      expect(stored?.status).toBe(PauseStatus.Pending);
      expect(replyDesk.payouts).toEqual([]);
    });
});
