/**
 * #267 AC8 / AC11 (PR 3): a free-text reply resumes a pause through its role's `@ReplyInterpreter`
 * — a model one (scripted with `mockLlm(Interpreter).when({ reply })`) or a code one (created by
 * the container, `mockOf` replaces it) — given the pause's original question; what it gives is
 * validated like a decision. A reply nobody can read throws `UninterpretableReplyError` and the
 * pause stays pending; a role without an interpreter throws `ReplyInterpreterMissingError`, the
 * pause untouched. The model call counts in the execution's spend and the tenant's ledger, once.
 */
import { beforeEach, describe, expect } from "vitest";
import { BudgetScope } from "../../src/budgets/budget.js";
import { ToolCallApprovalDecisionDto } from "../../src/dto/standard/framework.js";
import {
  BudgetExceededError,
  DtoValidationError,
  PauseStatus,
  ReplyInterpreterMissingError,
  UninterpretableReplyError,
} from "../../src/index.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { TestSetupError } from "../../src/testing/errors.js";
import { usd } from "../../src/units/index.js";
import { TestTenantDailyBudget } from "../flow/fixtures/budgets.js";
import {
  BookExpenseTool,
  ExpenseReplyInterpreter,
  PayOutTool,
  PayoutReplyInterpreter,
  replyDesk,
  resetReplyDesk,
  TransferTool,
  TreasurerAgent,
  TreasuryApplication,
  TreasuryWorkflowFinish,
  TreasuryDeskWorkflowFinish,
  TreasuryDeskWorkflowStart,
  TreasuryWorkflowStart,
  treasuryLedger,
  treasuryPauses,
} from "../flow/fixtures/replies.fixture.js";
import { execute } from "../helpers/flow.js";
import { requestText } from "../pii/boundary.helpers.js";

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

describe("#267 AC8: a model interpreter reads a free-text reply", () => {
  test("it gets the pause's question and the reply; its decision resumes the pause", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(TreasurerAgent).thenReturn(callTool(PayOutTool, payout), replyWith("Paid."));
    mockLlm(PayoutReplyInterpreter)
      .when({ reply: "ok, but only half" })
      .thenReturn(
        replyWith(ToolCallApprovalDecisionDto, {
          approved: true,
          overrideArguments: { payee: "ann", amountCents: 500 },
        }),
      );
    await execute(app, TreasuryWorkflowStart, { text: "pay ann $10" });

    const done = await app.resume(
      { pauseId: payoutPauseId(), reply: "ok, but only half" },
      manager,
    );

    expect(done).toFinishWith(TreasuryWorkflowFinish, { text: "Paid." });
    expect(replyDesk.payouts).toEqual([{ payee: "ann", amountCents: 500 }]);
    expect(mockLlm(PayoutReplyInterpreter).inputs).toEqual([
      {
        ask: expect.objectContaining({ tool: "pay_out", arguments: payout }),
        reply: "ok, but only half",
      },
    ]);
    expect(mockLlm(PayoutReplyInterpreter).onlyRequest).toMatchObject({
      kind: "chat",
      // the question and the reply in the input message, never in the instructions (#270 Q51)
      input: expect.stringMatching(/"amountCents": 1000[\s\S]*### reply\n"ok, but only half"/),
      system: expect.stringContaining("Decide approve / refuse and any changed amount."),
    });
  });

  test("its model reads the reply through the PII policies; its answer is revealed before validation", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(TreasurerAgent).thenReturn(callTool(PayOutTool, payout), replyWith("Paid."));
    const interpreter = mockLlm(PayoutReplyInterpreter);
    interpreter.thenAnswer((request) => {
      // the model sees the phone number as a token only, and answers with that token
      const [token = ""] = /<phone:[0-9a-f]+>/.exec(requestText(request)) ?? [];
      return replyWith(ToolCallApprovalDecisionDto, {
        approved: true,
        overrideArguments: { payee: token, amountCents: 1000 },
      });
    });
    await execute(app, TreasuryWorkflowStart, { text: "pay ann $10" });

    await app.resume(
      { pauseId: payoutPauseId(), reply: "yes, but pay +1 555 123 4567 instead" },
      manager,
    );

    const seen = requestText(interpreter.onlyRequest);
    expect(seen).toMatch(/pay <phone:[0-9a-f]+> instead/);
    expect(seen).not.toContain("555 123");
    expect(replyDesk.payouts).toEqual([{ payee: "+1 555 123 4567", amountCents: 1000 }]);
  });

  test("an answer with a token no map knows is unreadable: the pause stays pending", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(TreasurerAgent).thenReturn(callTool(PayOutTool, payout));
    mockLlm(PayoutReplyInterpreter).thenReturn(
      replyWith(ToolCallApprovalDecisionDto, {
        approved: true,
        overrideArguments: { payee: "<phone:0123456789ab>", amountCents: 1000 },
      }),
    );
    await execute(app, TreasuryWorkflowStart, { text: "pay ann $10" });

    const resumed = app.resume({ pauseId: payoutPauseId(), reply: "pay the other one" }, manager);

    await expect(resumed).rejects.toBeInstanceOf(UninterpretableReplyError);
    const stored = await treasuryPauses().findByTenantIdAndPauseId("default", payoutPauseId());
    expect(stored?.status).toBe(PauseStatus.Pending);
  });

  test("its call is in the execution's spend and the tenant's ledger, each once", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(TreasurerAgent).thenReturn(callTool(PayOutTool, payout), replyWith("Paid."));
    mockLlm(PayoutReplyInterpreter).thenReturn(
      replyWith(ToolCallApprovalDecisionDto, { approved: true }, { cost: usd(0.02) }),
    );
    await execute(app, TreasuryWorkflowStart, { text: "pay ann $10" });

    const done = await app.resume({ pauseId: payoutPauseId(), reply: "fine" }, manager);

    expect(done.spend.byCaller).toMatchObject({
      "reply-interpreter:payout-reply-interpreter": 0.02,
    });
    const tenantToday = {
      budget: "test-tenant-daily-budget",
      scope: BudgetScope.Tenant,
      key: "default",
      period: "2026-01-05",
    };
    const spent = await treasuryLedger().findSpentByCounter(tenantToday);
    expect(spent).toBeCloseTo(done.spend.totalUsd, 9);
    expect(done.spend.totalUsd).toBeCloseTo(0.02, 9);
  });

  test("its call counts in the tenant's budget: a reply that spends what is left stops the next call", async ({
    app,
    mockLlm,
    mockOf,
  }) => {
    mockOf(TestTenantDailyBudget).maxSpend.mockReturnValue(usd(0.05));
    mockLlm(TreasurerAgent).thenReturn(callTool(PayOutTool, payout));
    mockLlm(PayoutReplyInterpreter).thenReturn(
      replyWith(ToolCallApprovalDecisionDto, { approved: true }, { cost: usd(0.06) }),
    );
    await execute(app, TreasuryWorkflowStart, { text: "pay ann $10" });

    const resumed = app.resume({ pauseId: payoutPauseId(), reply: "fine" }, manager);

    await expect(resumed).rejects.toBeInstanceOf(BudgetExceededError);
    await expect(resumed).rejects.toMatchObject({ budget: { name: "test-tenant-daily-budget" } });
    // the decision is taken (the tool runs); the agent's next model call is stopped
    expect(mockLlm(TreasurerAgent).requests).toHaveLength(1);
  });

  test("the budgets are checked before its call: once spent, a reply is refused and the pause stays pending", async ({
    app,
    mockLlm,
    mockOf,
  }) => {
    mockOf(TestTenantDailyBudget).maxSpend.mockReturnValue(usd(0.01));
    mockLlm(TreasurerAgent).thenReturn(callTool(PayOutTool, payout));
    mockLlm(PayoutReplyInterpreter).thenReturn(replyWith("Unclear.", { cost: usd(0.02) }));
    await execute(app, TreasuryWorkflowStart, { text: "pay ann $10" });
    const pauseId = payoutPauseId();
    const unread = app.resume({ pauseId, reply: "hmm" }, manager);
    await expect(unread).rejects.toBeInstanceOf(UninterpretableReplyError);

    const refused = app.resume({ pauseId, reply: "yes" }, manager);

    await expect(refused).rejects.toBeInstanceOf(BudgetExceededError);
    expect(mockLlm(PayoutReplyInterpreter).requests).toHaveLength(1);
    const stored = await treasuryPauses().findByTenantIdAndPauseId("default", pauseId);
    expect(stored?.status).toBe(PauseStatus.Pending);
  });

  test("a model that gives no answer: UninterpretableReplyError, the pause stays pending", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(TreasurerAgent).thenReturn(callTool(PayOutTool, payout), replyWith("Paid."));
    mockLlm(PayoutReplyInterpreter)
      .when({ reply: "let me think" })
      .thenReturn(replyWith("I cannot tell what the manager decided."));
    await execute(app, TreasuryWorkflowStart, { text: "pay ann $10" });

    const unread = app.resume({ pauseId: payoutPauseId(), reply: "let me think" }, manager);

    await expect(unread).rejects.toBeInstanceOf(UninterpretableReplyError);
    const stored = await treasuryPauses().findByTenantIdAndPauseId("default", payoutPauseId());
    expect(stored?.status).toBe(PauseStatus.Pending);
    const done = await app.resume(
      { pauseId: payoutPauseId(), decision: { approved: true } },
      manager,
    );
    expect(done).toFinishWith(TreasuryWorkflowFinish, { text: "Paid." });
  });

  test("an answer the role rejects is uninterpretable: overrideArguments with approved: false", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(TreasurerAgent).thenReturn(callTool(PayOutTool, payout));
    mockLlm(PayoutReplyInterpreter).thenReturn(
      replyWith(ToolCallApprovalDecisionDto, {
        approved: false,
        overrideArguments: { payee: "bob", amountCents: 1 },
      }),
    );
    await execute(app, TreasuryWorkflowStart, { text: "pay ann $10" });

    const failed: unknown = await app
      .resume({ pauseId: payoutPauseId(), reply: "no, pay bob a cent" }, manager)
      .catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(UninterpretableReplyError);
    expect(failed).toHaveProperty("cause", expect.any(DtoValidationError));
    const stored = await treasuryPauses().findByTenantIdAndPauseId("default", payoutPauseId());
    expect(stored?.status).toBe(PauseStatus.Pending);
  });
});

describe("#267 AC8: a code interpreter reads a reply", () => {
  test("the owner's button value is read by the container's interpreter", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(TreasurerAgent).thenReturn(
      callTool(BookExpenseTool, { purpose: "lunch" }),
      replyWith("Booked."),
    );
    const paused = await execute(
      app,
      TreasuryWorkflowStart,
      { text: "book lunch" },
      { ownerId: "alice" },
    );
    const [pending] = paused.pending;

    const done = await app.resume(
      { pauseId: pending?.pauseId ?? "", reply: '{"approved":true}' },
      { ownerId: "alice" },
    );

    expect(done).toFinishWith(TreasuryWorkflowFinish, { text: "Booked." });
    expect(replyDesk.expenses).toEqual(["lunch"]);
  });

  test("it reads in the pause's execution frame: its tenant, owner and waiting step", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(TreasurerAgent).thenReturn(
      callTool(BookExpenseTool, { purpose: "lunch" }),
      replyWith("Booked."),
    );
    const owner = { ownerId: "alice", tenantId: "acme" };
    const paused = await execute(
      app,
      TreasuryWorkflowStart,
      { text: "book lunch" },
      { ownerId: "alice", tenant: { tenantId: "acme" } },
    );

    await app.resume(
      { pauseId: paused.pending[0]?.pauseId ?? "", reply: '{"approved":true}' },
      owner,
    );

    expect(replyDesk.readings).toEqual([
      { tenantId: "acme", ownerId: "alice", nodeId: "treasurer-agent", callId: "call-1" },
    ]);
  });

  test("a pause inside a child workflow is read in the child's frame", async ({ app, mockLlm }) => {
    mockLlm(TreasurerAgent).thenReturn(
      callTool(BookExpenseTool, { purpose: "taxi" }),
      replyWith("Booked."),
    );
    const owner = { ownerId: "alice", tenantId: "acme" };
    const paused = await execute(
      app,
      TreasuryDeskWorkflowStart,
      { text: "book a taxi" },
      { ownerId: "alice", tenant: { tenantId: "acme" } },
    );
    const [pending] = paused.pending;

    const done = await app.resume(
      { pauseId: pending?.pauseId ?? "", reply: '{"approved":true}' },
      owner,
    );

    expect(done).toFinishWith(TreasuryDeskWorkflowFinish, { text: "Booked." });
    expect(pending?.childExecutionId).toBeDefined();
    expect(replyDesk.readings).toEqual([
      { tenantId: "acme", ownerId: "alice", nodeId: "treasurer-agent", callId: "call-1" },
    ]);
  });

  test("a reply it declines (it throws): UninterpretableReplyError, the pause stays pending", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(TreasurerAgent).thenReturn(callTool(BookExpenseTool, { purpose: "lunch" }));
    const paused = await execute(app, TreasuryWorkflowStart, { text: "book lunch" });
    const pauseId = paused.pending[0]?.pauseId ?? "";

    const failed: unknown = await app
      .resume({ pauseId, reply: "yes please" })
      .catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(UninterpretableReplyError);
    expect(failed).toHaveProperty("cause", expect.any(SyntaxError));
    const stored = await treasuryPauses().findByTenantIdAndPauseId("default", pauseId);
    expect(stored?.status).toBe(PauseStatus.Pending);
  });
});

describe("#267 AC11: tests replace a code interpreter with mockOf", () => {
  test("mockOf(Interpreter).interpret answers instead of the class", async ({
    app,
    mockLlm,
    mockOf,
  }) => {
    mockOf(ExpenseReplyInterpreter).interpret.mockResolvedValue({
      approved: false,
      reason: "not this month",
    });
    mockLlm(TreasurerAgent).thenReturn(
      callTool(BookExpenseTool, { purpose: "lunch" }),
      replyWith("Not booked."),
    );
    const paused = await execute(app, TreasuryWorkflowStart, { text: "book lunch" });

    await app.resume({ pauseId: paused.pending[0]?.pauseId ?? "", reply: "anything" });

    expect(replyDesk.expenses).toEqual([]);
    expect(mockOf(ExpenseReplyInterpreter).interpret.mock.calls).toEqual([
      [{ ask: expect.objectContaining({ tool: "book_expense" }), reply: "anything" }],
    ]);
    expect(JSON.stringify(mockLlm(TreasurerAgent).lastRequest)).toContain("not this month");
  });

  test("mockLlm of a code interpreter is a setup error: it calls no model", async ({ mockLlm }) => {
    expect(() => mockLlm(ExpenseReplyInterpreter)).toThrow(TestSetupError);
  });
});

describe("#267 AC2 / AC8: what a reply resume takes", () => {
  test("a role without an interpreter: ReplyInterpreterMissingError, the pause untouched", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(TreasurerAgent).thenReturn(callTool(TransferTool, { account: "DE-1" }));
    await execute(app, TreasuryWorkflowStart, { text: "transfer" });
    const [ask] = replyDesk.transfers;

    const failed = app.resume({ pauseId: ask?.pauseId ?? "", reply: "yes" }, manager);

    await expect(failed).rejects.toBeInstanceOf(ReplyInterpreterMissingError);
    const stored = await treasuryPauses().findByTenantIdAndPauseId("default", ask?.pauseId ?? "");
    expect(stored).toMatchObject({ status: PauseStatus.Pending, isSent: true });
  });

  test.for([
    ["an empty reply", { pauseId: "p", reply: "  " }],
    ["a reply and a decision", { pauseId: "p", reply: "yes", decision: { approved: true } }],
  ] as const)("%s is refused before the pause is looked up", async ([, request], { app }) => {
    // an untyped (JS) caller: both forms, or an empty text, do not compile
    const refused = app.resume(request as never, manager);

    await expect(refused).rejects.toBeInstanceOf(DtoValidationError);
  });
});
