/**
 * #267 S124 (PR 4): (a) a decision model (Jev) reads a reply for an approval role — approve / refuse
 * only, one `Decision.noul("approved")` scripted with `decideWith({ approved: 0.9 })`, no `reason`,
 * no `overrideArguments`; (b) a code interpreter returns `ReplyInterpretation.understood(decision)` or
 * `ReplyInterpretation.notUnderstood({ reason })` — the latter is `UninterpretableReplyError` with
 * that reason and the pause stays pending; a throw is a crash (its error the cause); what is neither
 * does not compile, and at run time (a JS interpreter) is a crash too.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  ReplyInterpretation,
  type ReplyInterpreterHandler,
} from "../../src/channels/channel-role.decorator.js";
import { PauseStatus, UninterpretableReplyError } from "../../src/index.js";
import { callTool, decideWith, replyWith, testWith } from "../../src/testing/index.js";
import { usd } from "../../src/units/index.js";
import {
  BookExpenseTool,
  DepositReplyInterpreter,
  ExpenseReplyInterpreter,
  ReturnDepositTool,
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

const clerk = { answeredBy: "clerk-4" };

/** The clerk's only ask: its pause's id is the reply key. */
function depositPauseId(): string {
  const [ask] = replyDesk.depositAsks;
  if (ask === undefined) throw new Error("the clerk was not asked");
  return ask.pauseId;
}

describe("#267 S124 a: a decision model reads an approval's reply", () => {
  test("P(yes) above one half approves: one Decision.noul about the question and the reply", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(TreasurerAgent).thenReturn(
      callTool(ReturnDepositTool, { leaseId: "L-9" }),
      replyWith("Returned."),
    );
    mockLlm(DepositReplyInterpreter).thenReturn(decideWith({ approved: 0.9 }));
    await execute(app, TreasuryWorkflowStart, { text: "return the deposit of L-9" });

    const done = await app.resume(
      { pauseId: depositPauseId(), reply: "sure, go ahead" },
      { ...clerk, record: true },
    );

    expect(done).toFinishWith(TreasuryWorkflowFinish, { text: "Returned." });
    expect(replyDesk.deposits).toEqual(["L-9"]);
    expect(mockLlm(DepositReplyInterpreter).onlyRequest).toMatchObject({
      kind: "decide",
      state: expect.stringMatching(/"leaseId": "L-9"[\s\S]*### reply\n"sure, go ahead"/),
      questions: {
        approved: {
          type: "noul",
          instructions: expect.stringContaining("The clerk answered a deposit return."),
        },
      },
    });
    // approve / refuse only: no reason, no overrideArguments
    expect(done.record?.pauses).toMatchObject([{ decision: { approved: true } }]);
  });

  test("P(yes) at or below one half refuses: the tool does not run, the agent hears the refusal", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(TreasurerAgent).thenReturn(
      callTool(ReturnDepositTool, { leaseId: "L-9" }),
      replyWith("Not returned."),
    );
    mockLlm(DepositReplyInterpreter).thenReturn(decideWith({ approved: 0.2 }));
    await execute(app, TreasuryWorkflowStart, { text: "return the deposit of L-9" });

    const done = await app.resume(
      { pauseId: depositPauseId(), reply: "no, the flat is damaged" },
      { ...clerk, record: true },
    );

    expect(done).toFinishWith(TreasuryWorkflowFinish, { text: "Not returned." });
    expect(replyDesk.deposits).toEqual([]);
    expect(done.record?.pauses[0]?.decision).toEqual({ approved: false });
  });

  test("its call is counted under reply-interpreter:<name> in the execution's spend", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(TreasurerAgent).thenReturn(
      callTool(ReturnDepositTool, { leaseId: "L-9" }),
      replyWith("Returned."),
    );
    mockLlm(DepositReplyInterpreter).thenReturn(
      decideWith({ approved: 0.95 }, { cost: usd(0.003) }),
    );
    await execute(app, TreasuryWorkflowStart, { text: "return the deposit of L-9" });

    const done = await app.resume({ pauseId: depositPauseId(), reply: "yes" }, clerk);

    expect(done.spend.byCaller).toMatchObject({
      "reply-interpreter:deposit-reply-interpreter": 0.003,
    });
  });

  test("it reads the reply through the PII policies", async ({ app, mockLlm }) => {
    mockLlm(TreasurerAgent).thenReturn(
      callTool(ReturnDepositTool, { leaseId: "L-9" }),
      replyWith("Returned."),
    );
    mockLlm(DepositReplyInterpreter).thenReturn(decideWith({ approved: 0.9 }));
    await execute(app, TreasuryWorkflowStart, { text: "return the deposit of L-9" });

    await app.resume({ pauseId: depositPauseId(), reply: "yes — ann@example.com" }, clerk);

    const { state } = mockLlm(DepositReplyInterpreter).onlyRequest as { readonly state: string };
    expect(state).toContain("yes — <email>");
    expect(state).not.toContain("ann@example.com");
  });
});

describe("#267 S124 b: a code interpreter returns its outcome", () => {
  test("notUnderstood({ reason }): UninterpretableReplyError with that reason, the pause pending", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(TreasurerAgent).thenReturn(
      callTool(BookExpenseTool, { purpose: "lunch" }),
      replyWith("Booked."),
    );
    const paused = await execute(app, TreasuryWorkflowStart, { text: "book lunch" });
    const pauseId = paused.pending[0]?.pauseId ?? "";

    const failed: unknown = await app
      .resume({ pauseId, reply: '{"button":"maybe"}' })
      .catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(UninterpretableReplyError);
    expect(failed).toMatchObject({
      code: "pause.uninterpretable-reply",
      reason: 'not an expense button: {"button":"maybe"}',
    });
    expect(failed).not.toHaveProperty("cause");
    const stored = await treasuryPauses().findByTenantIdAndPauseId("default", pauseId);
    expect(stored?.status).toBe(PauseStatus.Pending);
    // the pause still takes a clearer answer
    const done = await app.resume({ pauseId, reply: '{"approved":true}' });
    expect(done).toFinishWith(TreasuryWorkflowFinish, { text: "Booked." });
  });

  test("understood(decision): the decision is validated like any other", async ({
    app,
    mockLlm,
    mockOf,
  }) => {
    mockOf(ExpenseReplyInterpreter).interpret.mockReturnValue(
      // an untyped (JS) interpreter: overrideArguments without approved: true is not a decision
      ReplyInterpretation.understood({ approved: false, overrideArguments: { purpose: "x" } }),
    );
    mockLlm(TreasurerAgent).thenReturn(callTool(BookExpenseTool, { purpose: "lunch" }));
    const paused = await execute(app, TreasuryWorkflowStart, { text: "book lunch" });

    const failed = app.resume({ pauseId: paused.pending[0]?.pauseId ?? "", reply: "no" });

    await expect(failed).rejects.toBeInstanceOf(UninterpretableReplyError);
  });

  test("what is neither outcome (a JS interpreter's plain object) is a crash, not a decision", async ({
    app,
    mockLlm,
    mockOf,
  }) => {
    // an untyped (JS) interpreter: a plain object does not compile (below)
    mockOf(ExpenseReplyInterpreter).interpret.mockReturnValue({ approved: true } as never);
    mockLlm(TreasurerAgent).thenReturn(callTool(BookExpenseTool, { purpose: "lunch" }));
    const paused = await execute(app, TreasuryWorkflowStart, { text: "book lunch" });

    const failed: unknown = await app
      .resume({ pauseId: paused.pending[0]?.pauseId ?? "", reply: "yes" })
      .catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(UninterpretableReplyError);
    expect(failed).toHaveProperty("cause", expect.any(TypeError));
    expect(replyDesk.expenses).toEqual([]);
  });

  it("a plain object, or a bare decision, does not compile as interpret's result", () => {
    class PlainReader implements ReplyInterpreterHandler<ExpenseReplyInterpreter> {
      // @ts-expect-error — interpret returns ReplyInterpretation.understood(…) / .notUnderstood(…)
      interpret(): { approved: boolean } {
        return { approved: true };
      }
    }
    const notUnderstood = ReplyInterpretation.notUnderstood({ reason: "unclear" });

    expect(PlainReader.name).toBe("PlainReader");
    expect(notUnderstood).toEqual({ kind: "not-understood", reason: "unclear" });
    expect(Object.isFrozen(notUnderstood)).toBe(true);
  });
});
