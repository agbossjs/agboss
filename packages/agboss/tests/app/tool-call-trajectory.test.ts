/**
 * #395 PR 1 — tool-call trajectories: `result.toolCalls` (real values), `result.record.toolCalls`
 * (masked), each child's own, `JudgeInput.toolCalls` (the visit's calls, every attempt) with
 * `toolCallsOf`, and `record.steps` — one entry per visit with its input hash, judge verdicts,
 * guardrail decisions and spend.
 */
import { describe, expect, it } from "vitest";
import {
  ChildExecutionStatus,
  ComponentKind,
  GuardrailSide,
  JudgeVerdict,
  ToolCallStatus,
  type ToolCallRecord,
} from "../../src/index.js";
import { PlainTextDto } from "../../src/dto/index.js";
import { callTool, replyWith, testJudge, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import {
  ClerkAgent,
  ClerkStart,
  FrontDeskStart,
  LookedUpJudge,
  LookupOrderTool,
  StrictClerkAgent,
  StrictClerkStart,
  TrajectoryApplication,
  TrajectoryLog,
} from "./fixtures/trajectory.workflow.js";

const HASH = /^[0-9a-f]{64}$/u;

describe("result.toolCalls", () => {
  const test = testWith(TrajectoryApplication);

  test("lists the visit's calls in call order: the tool, the agent's visit, input, output, status", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ClerkAgent).thenReturn(
      callTool(LookupOrderTool, { orderId: "7" }),
      callTool(LookupOrderTool, { orderId: "lost" }),
      replyWith("Order 7 has shipped."),
    );

    const result = await execute(app, ClerkStart, { text: "where are 7 and lost?" });

    expect(result.toolCalls.map((call) => call.status)).toEqual([
      ToolCallStatus.Succeeded,
      ToolCallStatus.Failed,
    ]);
    const [found, failed] = result.toolCalls;
    expect(found).toMatchObject({
      input: { orderId: "7" },
      output: { status: "order 7 shipped" },
      isResultTruncated: false,
      step: {
        component: { name: "lookup-order-tool", kind: ComponentKind.Tool },
        nodeId: "clerk-agent",
        visitNumber: 1,
        toolLoopIteration: 1,
        validationAttempts: 0,
      },
    });
    expect(found?.step.component.promptHash).toMatch(HASH);
    expect(found?.step.component.schemaHash).toMatch(HASH);
    expect(found?.step.callId).toEqual(expect.any(String));
    expect(found?.step.idempotencyKey).toContain(String(found?.step.callId));
    expect(failed).toMatchObject({
      input: { orderId: "lost" },
      output: undefined,
      error: { message: "no such order" },
      step: { toolLoopIteration: 2 },
    });
    expect(Date.parse(String(found?.startedAt))).not.toBeNaN();
  });

  test("a child's calls are in its own record, not the root's", async ({ app, mockLlm }) => {
    mockLlm(ClerkAgent).thenReturn(
      callTool(LookupOrderTool, { orderId: "7" }),
      replyWith("Shipped."),
    );

    const result = await execute(app, FrontDeskStart, { text: "where is 7?" });

    expect(result.toolCalls).toEqual([]);
    expect(result.children[0]?.toolCalls.map((call) => call.input)).toEqual([{ orderId: "7" }]);
  });

  test("the record's calls are masked by the application's PII policies, the result's are real", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ClerkAgent).thenReturn(
      callTool(LookupOrderTool, { orderId: "alice@example.com" }),
      replyWith("Shipped."),
    );

    const result = await execute(app, ClerkStart, { text: "where is it?" }, { record: true });

    expect(result.toolCalls[0]?.input).toEqual({ orderId: "alice@example.com" });
    expect(result.record?.toolCalls[0]?.input).toEqual({ orderId: "<email>" });
  });
});

describe("JudgeInput.toolCalls", () => {
  const test = testWith(TrajectoryApplication);

  test("holds the visit's calls of every attempt; the verdicts are the agent step's", async ({
    app,
    mockLlm,
    mockOf,
  }) => {
    const log = mockOf(TrajectoryLog);
    mockLlm(ClerkAgent).thenReturn(
      replyWith("It has shipped, I think."),
      callTool(LookupOrderTool, { orderId: "7" }),
      replyWith("Order 7 has shipped."),
    );

    const result = await execute(app, ClerkStart, { text: "where is 7?" }, { record: true });

    expect(log.seen.mock.calls.map(([calls]) => calls.length)).toEqual([0, 1]);
    const agentStep = result.record?.steps.find((step) => step.step.nodeId === "clerk-agent");
    expect(agentStep?.judgeVerdicts).toEqual([
      {
        judge: expect.objectContaining({ name: "looked-up-judge", kind: ComponentKind.Judge }),
        attempt: 0,
        passed: false,
        reason: "Look the order up first.",
      },
      {
        judge: expect.objectContaining({ name: "looked-up-judge" }),
        attempt: 1,
        passed: true,
        metrics: { lookups: 1 },
      },
    ]);
  });
});

describe("record.steps", () => {
  const test = testWith(TrajectoryApplication);

  test("one entry per visit, in order: its step, input hash, guardrail decisions and spend", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ClerkAgent).thenReturn(
      callTool(LookupOrderTool, { orderId: "7" }),
      replyWith("Order 7 has shipped."),
    );

    const result = await execute(app, ClerkStart, { text: "where is 7?" }, { record: true });

    const steps = result.record?.steps ?? [];
    expect(steps.map((step) => step.step.nodeId)).toEqual([
      "clerk-workflow-start",
      "clerk-agent",
      "clerk-workflow-finish",
    ]);
    expect(steps.every((step) => HASH.test(step.inputHash))).toBe(true);
    const [, agentStep] = steps;
    expect(agentStep?.guardrailDecisions).toEqual([
      {
        guardrail: expect.objectContaining({ name: "prompt-injection-guardrail" }),
        side: GuardrailSide.Input,
        isBlocked: false,
        probability: expect.any(Number),
      },
    ]);
    expect(agentStep?.spend.calls).toBeGreaterThan(0);
    expect(agentStep?.step.component).toMatchObject({
      name: "clerk-agent",
      kind: ComponentKind.Agent,
    });
  });

  test("the same input gives the same hash, another input another", async ({ app, mockLlm }) => {
    const lookUpAndAnswer = [callTool(LookupOrderTool, { orderId: "7" }), replyWith("Shipped.")];
    mockLlm(ClerkAgent).thenReturn(...lookUpAndAnswer, ...lookUpAndAnswer, ...lookUpAndAnswer);
    const agentHashOf = async (text: string): Promise<string | undefined> => {
      const result = await execute(app, ClerkStart, { text }, { record: true });
      return result.record?.steps.find((step) => step.step.nodeId === "clerk-agent")?.inputHash;
    };

    const first = await agentHashOf("where is 7?");
    const again = await agentHashOf("where is 7?");
    const other = await agentHashOf("where is 8?");

    expect(again).toBe(first);
    expect(other).not.toBe(first);
  });
});

/** A succeeded lookup as a trajectory holds it. */
const LOOKUP: ToolCallRecord = {
  step: {
    component: {
      name: "lookup-order-tool",
      kind: ComponentKind.Tool,
      promptHash: undefined,
      schemaHash: undefined,
    },
    nodeId: "clerk-agent",
    visitNumber: 1,
    copyNumber: 1,
    itemIndex: undefined,
    idempotencyKey: "execution-1:clerk-agent:1:call-1",
    callId: "call-1",
    toolLoopIteration: 1,
    validationAttempts: 0,
  },
  input: { orderId: "7" },
  output: { status: "order 7 shipped" },
  status: ToolCallStatus.Succeeded,
  isResultTruncated: false,
  startedAt: "2026-01-05T09:00:00.000Z",
  endedAt: "2026-01-05T09:00:00.000Z",
};

describe("testJudge", () => {
  const reply = { variant: PlainTextDto, reply: { text: "Shipped." }, task: "t", attempt: 0 };

  it("takes no toolCalls: the judge reads none", async () => {
    const { output } = await testJudge(LookedUpJudge)(reply);

    expect(output).toEqual(JudgeVerdict.failed({ reason: "Look the order up first." }));
  });

  it("passes the toolCalls it is given", async () => {
    const { output } = await testJudge(LookedUpJudge)({ ...reply, toolCalls: [LOOKUP] });

    expect(output).toEqual(JudgeVerdict.passed({ metrics: { lookups: 1 } }));
  });
});

describe("a failed visit keeps its calls and verdicts (#395 S6)", () => {
  const test = testWith(TrajectoryApplication);

  test("a QualityGateError a side path takes: the agent's calls, verdict and failure in the record", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(StrictClerkAgent).thenReturn(
      callTool(LookupOrderTool, { orderId: "lost" }),
      replyWith("It has shipped."),
    );

    const result = await execute(app, StrictClerkStart, { text: "where is it?" }, { record: true });

    expect(result.finish?.name).toBe("hand-over-workflow-finish");
    expect(result.toolCalls.map((call) => call.status)).toEqual([ToolCallStatus.Failed]);
    const agentStep = result.record?.steps.find(
      (step) => step.step.nodeId === "strict-clerk-agent",
    );
    expect(agentStep).toMatchObject({
      judgeVerdicts: [{ attempt: 0, passed: false, reason: "Look the order up first." }],
      guardrailDecisions: [],
      error: { code: "step.agent.quality-gate" },
    });
    expect(agentStep?.spend.calls).toBeGreaterThan(0);
  });

  test("a child that fails: its record keeps the failed visit's calls and steps", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ClerkAgent).thenReturn(
      replyWith("It shipped, I guess."),
      callTool(LookupOrderTool, { orderId: "lost" }),
      replyWith("Still shipped."),
    );

    const result = await execute(app, FrontDeskStart, { text: "where is it?" });

    expect(result.finish?.name).toBe("hand-over-workflow-finish");
    const [child] = result.children;
    expect(child?.status).toBe(ChildExecutionStatus.Failed);
    expect(child?.toolCalls.map((call) => call.status)).toEqual([ToolCallStatus.Failed]);
    expect(child?.steps.map((step) => step.step.nodeId)).toEqual([
      "clerk-workflow-start",
      "clerk-agent",
    ]);
    expect(child?.steps[1]).toMatchObject({
      judgeVerdicts: [
        { attempt: 0, passed: false },
        { attempt: 1, passed: false },
      ],
      error: { code: "step.agent.quality-gate" },
    });
    expect(result.toolCalls).toEqual([]);
  });

  test("a child that finishes: its own steps, in order", async ({ app, mockLlm }) => {
    mockLlm(ClerkAgent).thenReturn(
      callTool(LookupOrderTool, { orderId: "7" }),
      replyWith("Shipped."),
    );

    const result = await execute(app, FrontDeskStart, { text: "where is 7?" });

    expect(result.children[0]?.steps.map((step) => step.step.nodeId)).toEqual([
      "clerk-workflow-start",
      "clerk-agent",
      "clerk-workflow-finish",
    ]);
  });
});
