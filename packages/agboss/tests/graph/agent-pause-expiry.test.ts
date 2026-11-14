/**
 * #941 AC5: an approval inside an agent expires: the agent step fails with `PauseExpiredError`, its
 * spend kept, caught by `.onError` after the agent — none of the move's calls ran; with a decided
 * refusal the model reads it (by the channel's name) and goes on; with a decided approval the tool
 * runs. A tool's own `expiresIn` wins over its role's; a question the agent asks (#712) fails the
 * agent step the same way.
 */
import { beforeEach, describe, expect } from "vitest";
import { ExecutionStatus } from "../../src/app/types.js";
import { PauseExpiration } from "../../src/channels/pause-expiration.js";
import { ResumeReason } from "../../src/core/observability.js";
import { PauseExpiredError } from "../../src/errors.js";
import {
  callTool,
  callTools,
  replyWith,
  testWith,
  type ModelRequest,
} from "../../src/testing/index.js";
import { hours } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { until } from "../channels/fixtures/pause-scripts.js";
import {
  AgentBareWorkflowStart,
  AgentExpiryApplication,
  AgentExpiryWorkflowStart,
  AgentRefundDoneDto,
  agentExpiry,
  ExpiringRefundTool,
  ExpiryRefundAgent,
  resetAgentExpiry,
  UrgentRefundTool,
} from "../flow/fixtures/agent-expiry.fixture.js";
import { expiry, resetExpiry, ManagerQuestion } from "../flow/fixtures/expiry.fixture.js";

const test = testWith(AgentExpiryApplication);
const THREAD = { threadId: "agent-expiry-1" };
const ORDER = { orderId: "7" };
const done = replyWith(AgentRefundDoneDto, { text: "done" });

beforeEach(() => {
  resetAgentExpiry();
  resetExpiry();
});

describe("#941 AC5: an approval inside an agent expires", () => {
  test("AC5: the agent step fails with PauseExpiredError, its spend kept; .onError after the agent takes it; the tool never ran", async ({
    app,
    clock,
    mockLlm,
  }) => {
    mockLlm(ExpiryRefundAgent).thenReturn(callTool(ExpiringRefundTool, ORDER));
    const paused = await execute(app, AgentExpiryWorkflowStart, ORDER, THREAD);
    expect(paused.status).toBe(ExecutionStatus.Paused);

    await clock.advance(hours(24));
    await until(() => expiry.recorded.length === 1);

    expect(expiry.recorded).toEqual(["escalated 7"]);
    expect(agentExpiry.refunds).toEqual([]);
    expect(agentExpiry.asked).toHaveLength(1);
    expect(expiry.resumes).toMatchObject([{ reason: ResumeReason.Expired }]);
  });

  test("AC5: uncaught, the run fails with PauseExpiredError: the agent, its approval's channel, the loop's usage", async ({
    app,
    clock,
    mockLlm,
  }) => {
    mockLlm(ExpiryRefundAgent).thenReturn(callTool(ExpiringRefundTool, ORDER));
    await execute(app, AgentBareWorkflowStart, ORDER, THREAD);

    await clock.advance(hours(24));
    await until(() => expiry.errors.length === 1);

    const [error] = expiry.errors;
    expect(error).toBeInstanceOf(PauseExpiredError);
    expect(error).toMatchObject({
      step: "expiry-refund-agent",
      stepKind: "agent",
      channel: "expiring-refund-approval",
      kind: "approval",
    });
    expect((error as PauseExpiredError).usage.length).toBeGreaterThan(0);
  });

  test("AC5: the move's first call is approved, the second expires: neither ran", async ({
    app,
    clock,
    mockLlm,
  }) => {
    mockLlm(ExpiryRefundAgent).thenReturn(
      callTools(
        callTool(ExpiringRefundTool, { orderId: "1" }),
        callTool(ExpiringRefundTool, { orderId: "2" }),
      ),
    );
    await execute(app, AgentExpiryWorkflowStart, ORDER, THREAD);
    await until(() => agentExpiry.sent.length === 1);
    // the first call's approval comes in time; the second is asked next, and nobody answers it
    await app.resume(
      { pauseId: agentExpiry.sent[0]?.pauseId ?? "", decision: { approved: true } },
      { answeredBy: "manager-17" },
    );
    await until(() => agentExpiry.sent.length === 2);

    await clock.advance(hours(24));
    await until(() => expiry.recorded.length === 1);

    expect(agentExpiry.refunds).toEqual([]);
    expect(expiry.recorded).toEqual(["escalated 7"]);
  });

  test("AC5: a tool's expiresIn of 4 h wins over its role's 24 h", async ({
    app,
    clock,
    mockLlm,
  }) => {
    mockLlm(ExpiryRefundAgent).thenReturn(callTool(UrgentRefundTool, ORDER));

    const paused = await execute(app, AgentExpiryWorkflowStart, ORDER, THREAD);

    expect(paused.pending[0]?.expiresAt).toBe(
      new Date(clock.now().getTime() + hours(4)).toISOString(),
    );
  });

  test("AC5: decide({ approved: true }): the tool runs, the agent goes on", async ({
    app,
    clock,
    mockLlm,
  }) => {
    agentExpiry.behavior = () => PauseExpiration.decide({ approved: true });
    mockLlm(ExpiryRefundAgent).thenReturn(callTool(ExpiringRefundTool, ORDER), done);
    await execute(app, AgentExpiryWorkflowStart, ORDER, THREAD);

    await clock.advance(hours(24));
    await until(() => expiry.ended.length === 1);

    expect(agentExpiry.refunds).toEqual(["7"]);
    expect(expiry.resumes).toMatchObject([
      { reason: ResumeReason.Expired, decision: { approved: true } },
    ]);
  });

  test("AC5: decide({ approved: false, reason }): the model reads the rejection by the channel's name, the loop goes on", async ({
    app,
    clock,
    mockLlm,
  }) => {
    agentExpiry.behavior = () =>
      PauseExpiration.decide({ approved: false, reason: "nobody was there" });
    const seen: ModelRequest[] = [];
    mockLlm(ExpiryRefundAgent).thenAnswer((request) => {
      seen.push(request);
      return seen.length === 1 ? callTool(ExpiringRefundTool, ORDER) : done;
    });
    await execute(app, AgentExpiryWorkflowStart, ORDER, THREAD);

    await clock.advance(hours(24));
    await until(() => expiry.ended.length === 1);

    expect(agentExpiry.refunds).toEqual([]);
    const second = JSON.stringify(seen[1]);
    expect(second).toContain("rejected by expiring-refund-approval");
    expect(second).toContain("nobody was there");
  });

  test("AC5: a question the agent asks through its tool loop (#712) expires: the agent step fails", async ({
    app,
    clock,
    mockLlm,
  }) => {
    mockLlm(ExpiryRefundAgent).thenReturn(callTool(ManagerQuestion, { orderId: "7" }));
    await execute(app, AgentBareWorkflowStart, ORDER, THREAD);

    await clock.advance(hours(24));
    await until(() => expiry.errors.length === 1);

    expect(expiry.errors[0]).toBeInstanceOf(PauseExpiredError);
    expect(expiry.errors[0]).toMatchObject({ step: "expiry-refund-agent", kind: "question" });
  });
});
