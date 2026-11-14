/**
 * #941 I6 / I17: a pause expires only when its tree rests, or by the holder of a pass at its drain
 * — never mid-pass. Two items' pauses of a per-item launch expire in one pass; a branch whose
 * pause is due while its sibling still runs is refused answers (I2) and expired by the holder once
 * the pass came to rest, the launch going on per its failure policy.
 */
import { beforeEach, describe, expect } from "vitest";
import { ExecutionStatus } from "../../src/app/types.js";
import { PauseExpiration } from "../../src/channels/pause-expiration.js";
import { ResumeReason } from "../../src/core/observability.js";
import { PauseClosedError, PauseExpiredError } from "../../src/errors.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { hours, seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { orderOf, until } from "../channels/fixtures/pause-scripts.js";
import {
  AgentBatchWorkflowStart,
  AgentExpiryApplication,
  AgentGatedWorkflowStart,
  AgentRefundDoneDto,
  agentExpiry,
  ExpiringRefundTool,
  ExpiryBatchRefundAgent,
  ExpiryHoldAgent,
  ExpiryRefundAgent,
  GateDto,
  QuickRefundTool,
  GateTool,
  resetAgentExpiry,
} from "../flow/fixtures/agent-expiry.fixture.js";
import { expiry, resetExpiry } from "../flow/fixtures/expiry.fixture.js";

const test = testWith(AgentExpiryApplication);
const THREAD = { threadId: "launch-expiry-1" };

beforeEach(() => {
  resetAgentExpiry();
  resetExpiry();
});

describe("#941 I6: per-item launch", () => {
  test("I6: two items' pauses expire in one pass; each decided answer goes on with its branch", async ({
    app,
    clock,
    mockLlm,
  }) => {
    agentExpiry.behavior = () => PauseExpiration.decide({ approved: true });
    mockLlm(ExpiryBatchRefundAgent).thenAnswer((request) => {
      const orderId = orderOf(request);
      const isAnswered =
        request.kind === "chat" && request.messages.some((line) => line.role === "tool");
      return isAnswered
        ? replyWith(AgentRefundDoneDto, { text: `refunded ${orderId}` })
        : callTool(ExpiringRefundTool, { orderId });
    });
    const paused = await execute(
      app,
      AgentBatchWorkflowStart,
      [{ orderId: "A" }, { orderId: "B" }],
      THREAD,
    );
    expect(paused.status).toBe(ExecutionStatus.Paused);
    expect(paused.pending).toHaveLength(2);

    await clock.advance(hours(24));
    await until(() => expiry.ended.length === 1);

    expect(agentExpiry.refunds.sort()).toEqual(["A", "B"]);
    expect(agentExpiry.asked).toHaveLength(2);
    expect(expiry.resumes.map((event) => event.reason)).toEqual([
      ResumeReason.Expired,
      ResumeReason.Expired,
    ]);
  });
});

describe("#941 I6: a branch's pause is due while its sibling still runs", () => {
  test("I6: no answer is accepted after the deadline; at the rest the holder expires it and the launch fails per its policy", async ({
    app,
    clock,
    mockLlm,
  }) => {
    let open: () => void = () => undefined;
    agentExpiry.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    mockLlm(ExpiryRefundAgent).thenReturn(callTool(QuickRefundTool, { orderId: "7" }));
    mockLlm(ExpiryHoldAgent).thenReturn(
      callTool(GateTool, { what: "hold" }),
      replyWith(GateDto, { what: "held" }),
    );
    // the first pass holds at the gate: its branch 1 pauses, its branch 2 runs
    const running = execute(app, AgentGatedWorkflowStart, { orderId: "7" }, THREAD);
    running.catch(() => undefined);
    await until(() => agentExpiry.sent.length === 1);

    await clock.advance(seconds(6));
    // the pass still runs: the look takes nothing, the handler is not asked, an answer is refused
    expect(agentExpiry.asked).toHaveLength(0);
    const refused = await app
      .resume(
        { pauseId: agentExpiry.sent[0]?.pauseId ?? "", decision: { approved: true } },
        { answeredBy: "manager-17" },
      )
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PauseClosedError);
    expect(refused).toMatchObject({ reason: "expired" });

    open();
    await until(() => expiry.errors.length === 1);

    expect(agentExpiry.asked).toHaveLength(1);
    expect(agentExpiry.refunds).toEqual([]);
    expect(expiry.errors[0]).toBeInstanceOf(PauseExpiredError);
    // the pass the holder's drain started is announced Expired, not Answered
    expect(expiry.resumes.map((event) => event.reason)).toEqual([ResumeReason.Expired]);
    await running.catch(() => undefined);
  });
});
