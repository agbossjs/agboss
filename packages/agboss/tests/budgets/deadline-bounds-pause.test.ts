/**
 * #941 AC6 (I18, D8): a run's deadline bounds every pause. A run with a 5-minute deadline paused on
 * a 24-hour question has a pause that expires at minute 5 — the run fails with
 * `DeadlineExceededError`, the pause is expired, the channel's expiry decision is not asked; the
 * same for an agent's approval (its loop's usage kept), a child's pause (bounded by the root's
 * deadline, expired through the root), and a tie between the deadline and `expiresIn`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { DeadlineExceededError } from "../../src/budgets/execution-deadline.js";
import { ExecutionStatus } from "../../src/app/types.js";
import { ResumeReason } from "../../src/core/observability.js";
import {
  PauseExpiryBound,
  PauseResolution,
  PauseStatus,
  type PauseRecord,
} from "../../src/infrastructure/pause-record.js";
import { expiryFailureOf } from "../../src/flow/runtime/pause-expiry-failure.js";
import { callTool, testWith } from "../../src/testing/index.js";
import { hours, minutes, seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { until } from "../channels/fixtures/pause-scripts.js";
import {
  ChildPausesApplication,
  ChildRefundAgent,
  SingleChildWorkflowStart,
} from "../channels/fixtures/child-pauses.workflow.js";
import { RefundTool, pauseStore, resetPauses, seen } from "../channels/fixtures/pauses.workflow.js";
import {
  AgentBareWorkflowStart,
  AgentExpiryApplication,
  ExpiringRefundTool,
  ExpiryRefundAgent,
  resetAgentExpiry,
} from "../flow/fixtures/agent-expiry.fixture.js";
import {
  ExpiryApplication,
  ExpiryWorkflowStart,
  expiry,
  expiryStore,
  resetExpiry,
} from "../flow/fixtures/expiry.fixture.js";
import { ComponentKind } from "../../src/flow/runtime/records.js";

const manager = testWith(ExpiryApplication);
const agent = testWith(AgentExpiryApplication);
const child = testWith(ChildPausesApplication);
const ORDER = { orderId: "o-1" };
const THREAD = { threadId: "deadline-1" };

beforeEach(() => {
  resetExpiry();
  resetAgentExpiry();
  resetPauses();
});

describe("#941 AC6: the run's deadline bounds a pause", () => {
  manager(
    "AC6: deadline 5 min, question 24 h: expiresAt is the run's; at minute 5 the run fails with DeadlineExceededError, the handler is not asked",
    async ({ app, clock }) => {
      const paused = await execute(app, ExpiryWorkflowStart, ORDER, {
        ...THREAD,
        deadline: minutes(5),
      });
      expect(paused.status).toBe(ExecutionStatus.Paused);
      const expiresAt = new Date(clock.now().getTime() + minutes(5)).toISOString();
      expect(paused.pending[0]?.expiresAt).toBe(expiresAt);

      await clock.advance(minutes(5));
      await until(() => expiry.errors.length === 1);

      expect(expiry.errors[0]).toBeInstanceOf(DeadlineExceededError);
      expect(expiry.errors[0]).toMatchObject({ deadlineAt: expiresAt, deadline: minutes(5) });
      expect(expiry.asked).toHaveLength(0);
      expect(expiry.directorAsked).toHaveLength(0);
      const [pause] = await expiryStore().findAllByTenantIdAndRootExecutionId(
        "default",
        paused.executionId,
      );
      expect(pause).toMatchObject({
        status: PauseStatus.Cancelled,
        resolution: PauseResolution.Expired,
        expiryBound: PauseExpiryBound.RunDeadline,
      });
      expect(expiry.resumes).toMatchObject([{ reason: ResumeReason.Expired }]);
    },
  );

  manager(
    "AC6: a tie between the run's deadline and expiresIn goes to the run: no decision is asked",
    async ({ app, clock }) => {
      const paused = await execute(app, ExpiryWorkflowStart, ORDER, {
        ...THREAD,
        deadline: hours(24),
      });

      await clock.advance(hours(24));
      await until(() => expiry.errors.length === 1);

      expect(expiry.errors[0]).toBeInstanceOf(DeadlineExceededError);
      expect(expiry.asked).toHaveLength(0);
      const [pause] = await expiryStore().findAllByTenantIdAndRootExecutionId(
        "default",
        paused.executionId,
      );
      expect(pause?.expiryBound).toBe(PauseExpiryBound.RunDeadline);
    },
  );

  manager(
    "AC6: a deadline longer than expiresIn: the pause's own deadline wins, the handler decides",
    async ({ app, clock }) => {
      const paused = await execute(app, ExpiryWorkflowStart, ORDER, {
        ...THREAD,
        deadline: hours(48),
      });

      await clock.advance(hours(24));
      await until(() => expiry.directorAsked.length === 1);

      const [pause] = await expiryStore().findAllByTenantIdAndRootExecutionId(
        "default",
        paused.executionId,
      );
      expect(pause?.expiryBound).toBe(PauseExpiryBound.Pause);
      expect(expiry.asked).toHaveLength(1);
    },
  );

  agent(
    "AC6 (V5): the run's deadline bounds an agent's tool approval: the agent's visit fails with DeadlineExceededError at the deadline",
    async ({ app, clock, mockLlm }) => {
      mockLlm(ExpiryRefundAgent).thenReturn(callTool(ExpiringRefundTool, { orderId: "7" }));
      await execute(
        app,
        AgentBareWorkflowStart,
        { orderId: "7" },
        {
          ...THREAD,
          deadline: minutes(5),
        },
      );

      await clock.advance(minutes(5));
      await until(() => expiry.errors.length === 1);

      expect(expiry.errors[0]).toBeInstanceOf(DeadlineExceededError);
      expect(expiry.errors[0]).toMatchObject({ deadline: minutes(5) });
    },
  );

  child(
    "AC6: a child's pause is bounded by the root's deadline and expires through the root",
    async ({ app, clock, mockLlm }) => {
      mockLlm(ChildRefundAgent).thenReturn(callTool(RefundTool, { orderId: "A" }));
      const paused = await execute(
        app,
        SingleChildWorkflowStart,
        { orderId: "A" },
        { tenant: { tenantId: "acme" }, threadId: "child-deadline", deadline: minutes(5) },
      );
      const expiresAt = new Date(clock.now().getTime() + minutes(5)).toISOString();
      expect(paused.pending[0]?.expiresAt).toBe(expiresAt);

      await clock.advance(minutes(5));
      await until(() => seen.closed.length === 1);

      expect(seen.closed[0]).toMatchObject({ reason: "expired", closedAt: expiresAt });
      const [pause] = await pauseStore().findAllByTenantIdAndRootExecutionId(
        "acme",
        paused.executionId,
      );
      expect(pause).toMatchObject({ resolution: PauseResolution.Expired });
      expect(seen.resumes).toMatchObject([{ reason: ResumeReason.Expired }]);
    },
  );
});

describe("#941 V5: the step builds DeadlineExceededError itself when its own check passes", () => {
  const pause = (expiryBound: PauseExpiryBound): PauseRecord =>
    ({
      pauseId: "p-1",
      tenantId: "acme",
      channel: "expiring-manager-question",
      kind: "question",
      askedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:05:00.000Z",
      expiryBound,
    }) as never;
  const place = (check: () => void) => ({
    step: "expiring-manager-question",
    stepKind: ComponentKind.Question as const,
    state: [],
    usage: [],
    path: ["start", "expiring-manager-question"],
    budgets: { check },
  });

  it("a pass whose clock is a few ms behind: its check does not throw, the error still carries the pause's deadline", () => {
    const error = expiryFailureOf(
      pause(PauseExpiryBound.RunDeadline),
      place(() => undefined),
    );

    expect(error).toBeInstanceOf(DeadlineExceededError);
    expect(error).toMatchObject({ deadlineAt: "2026-01-01T00:05:00.000Z", deadline: minutes(5) });
  });

  it("an agent's approval node builds it with the loop's usage (the visit's own check normally fails first)", () => {
    const usage = [{ caller: "agent", costUsd: 0.5 }] as never;
    const error = expiryFailureOf(pause(PauseExpiryBound.RunDeadline), {
      ...place(() => undefined),
      usage,
    });

    expect(error).toMatchObject({ usage, spentUsd: 0.5 });
  });

  it("its own check throwing the deadline: that error, the way every visit gets it", () => {
    const own = new DeadlineExceededError({
      deadline: seconds(300),
      deadlineAt: "2026-01-01T00:05:00.000Z",
      path: [],
      spentUsd: 0,
    });

    const error = expiryFailureOf(
      pause(PauseExpiryBound.RunDeadline),
      place(() => {
        throw own;
      }),
    );

    expect(error).toBe(own);
  });

  it("a pause bound by its own expiresIn: PauseExpiredError, never a deadline", () => {
    const error = expiryFailureOf(
      pause(PauseExpiryBound.Pause),
      place(() => undefined),
    );

    expect(error).not.toBeInstanceOf(DeadlineExceededError);
    expect(error).toMatchObject({ code: "step.pause-expired" });
  });
});
