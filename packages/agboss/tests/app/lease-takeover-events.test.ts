/**
 * #501 PR 1 — the takeover of a tree's lease, told: `onExecutionLeaseTakeover` and a `Takeover` row
 * of the lease log (`app.leaseEventsOf`), naming who took the lease at which token, from whom when
 * the lease store says, and why. A lease released and taken again is no takeover; an observer that
 * throws or a lease log that is down never reaches the takeover.
 */
import { afterEach, beforeEach, describe, expect } from "vitest";
import { ExecutionLeaseEventKind, LeaseTakeoverReason, ResumeReason } from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { hours, seconds } from "../../src/units/index.js";
import { logged, resetLogged } from "../helpers/log.js";
import { answerOf, execute } from "../helpers/flow.js";
import { resetRecovery, seen as recovery } from "../infrastructure/fixtures/recovery.workflow.js";
import { instance, rejectionOf, settle, takenOver } from "./fixtures/fence-takeover.js";
import { FarParentWorkflowStart, resetScopes } from "./fixtures/fence-children.workflow.js";
import {
  AgentReleaseWorkflowStart,
  ApprovedStageTool,
  levers,
  ReceiptDto,
  ReleaseAgent,
  resetFence,
  seen,
} from "./fixtures/fence.workflow.js";
import {
  DownLeaseLogApplication,
  LeaseEventsApplication,
  leaseSeen,
  resetLeaseEvents,
  SilentTakeoverApplication,
  ThrowingLeaseObserverApplication,
} from "./fixtures/lease-events.application.js";
import { callTool, replyWith } from "../../src/testing/index.js";

const test = testWith(LeaseEventsApplication);
const two = testWith(LeaseEventsApplication, { instances: 2 });
const throwing = testWith(ThrowingLeaseObserverApplication, { instances: 2 });
const silent = testWith(SilentTakeoverApplication, { instances: 2 });
const down = testWith(DownLeaseLogApplication, { instances: 2 });

beforeEach(() => {
  resetFence();
  resetRecovery();
  resetScopes();
  resetLeaseEvents();
  resetLogged();
});

afterEach(() => {
  levers.letGo?.();
});

/** The root the stalled writer of `takenOver` ran: its fence's execution. */
const zombieRoot = (): string => seen.fences[0]?.leaseExecutionId ?? "";

/** Lets the zombie go and waits for its call to end, so the test's apps close cleanly. */
async function letZombieGo(apps: readonly TestApp[], call: Promise<unknown>): Promise<unknown> {
  levers.letGo?.();
  await settle();
  return rejectionOf(call);
}

describe("#501 AC1: a takeover is told and kept", () => {
  two(
    "AC1: recovery after expiry emits one takeover event naming both holders and the new token, and it is in leaseEventsOf",
    async ({ apps, clock, leases }) => {
      const { call } = await takenOver(apps, clock, leases);
      const rootExecutionId = zombieRoot();

      const rows = await instance(apps, 1).leaseEventsOf({ tenantId: "default", rootExecutionId });
      const fromZombie = await instance(apps, 0).leaseEventsOf({
        tenantId: "default",
        rootExecutionId,
      });

      const expected = {
        tenantId: "default",
        rootExecutionId,
        leaseExecutionId: rootExecutionId,
        scopeKey: `default:${rootExecutionId}`,
        token: 2,
        holderInstanceId: "instance-2",
        previousHolderInstanceId: "instance-1",
        previousToken: 1,
        reason: LeaseTakeoverReason.Recovered,
      };
      expect(leaseSeen.takeovers).toEqual([{ ...expected, checkpointId: expect.any(String) }]);
      expect(rows).toEqual([
        {
          kind: ExecutionLeaseEventKind.Takeover,
          occurredAt: expect.any(String),
          tenantId: "default",
          rootExecutionId,
          executionId: rootExecutionId,
          scopeKey: `default:${rootExecutionId}`,
          token: 2,
          holderInstanceId: "instance-2",
          previousHolderInstanceId: "instance-1",
          previousToken: 1,
          reason: LeaseTakeoverReason.Recovered,
          checkpointId: leaseSeen.takeovers[0]?.checkpointId,
        },
      ]);
      expect(fromZombie).toEqual(rows);
      // regression: the recovery itself is unchanged
      expect(recovery.resumes).toEqual([{ reason: ResumeReason.Recovered, decision: undefined }]);
      leases.resume(instance(apps, 0));
      await letZombieGo(apps, call);
    },
  );

  two(
    "AC1: another tenant's tree, or another root, has no rows",
    async ({ apps, clock, leases }) => {
      const { call } = await takenOver(apps, clock, leases);
      const b = instance(apps, 1);

      expect(await b.leaseEventsOf({ tenantId: "acme", rootExecutionId: zombieRoot() })).toEqual(
        [],
      );
      expect(await b.leaseEventsOf({ tenantId: "default", rootExecutionId: "nope" })).toEqual([]);
      leases.resume(instance(apps, 0));
      await letZombieGo(apps, call);
    },
  );

  two(
    "a lease released at a pause and taken by the resume on the other instance is no takeover",
    async ({ apps, mockLlm }) => {
      const [a, b] = [instance(apps, 0), instance(apps, 1)];
      mockLlm(ReleaseAgent).thenReturn(
        callTool(ApprovedStageTool, { artifact: "v1" }),
        replyWith(ReceiptDto, { text: "staged" }),
      );
      const paused = await execute(a, AgentReleaseWorkflowStart, { text: "stage v1" });

      const result = await b.resume(answerOf(paused, { approved: true }));

      expect(result.output).toEqual({ text: "staged" });
      expect(seen.fences.map((each) => each.token)).toEqual([2]);
      expect(leaseSeen.takeovers).toEqual([]);
      expect(
        await b.leaseEventsOf({ tenantId: "default", rootExecutionId: result.executionId }),
      ).toEqual([]);
    },
  );

  test("a re-acquire after a yield (an AnyInstance child) is a Reacquired takeover at a new token, with no previous holder", async ({
    app,
  }) => {
    const result = await execute(app, FarParentWorkflowStart, { text: "go" });
    const { executionId: rootExecutionId } = result;

    const rows = await app.leaseEventsOf({ tenantId: "default", rootExecutionId });

    expect(leaseSeen.takeovers).toEqual([
      {
        tenantId: "default",
        rootExecutionId,
        leaseExecutionId: rootExecutionId,
        scopeKey: `default:${rootExecutionId}`,
        token: 2,
        holderInstanceId: "instance-1",
        reason: LeaseTakeoverReason.Reacquired,
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: ExecutionLeaseEventKind.Takeover,
      reason: LeaseTakeoverReason.Reacquired,
      token: 2,
    });
    expect(rows[0]).not.toHaveProperty("previousHolderInstanceId");
  });

  test("the recovery sweep removes rows older than leaseEventRetention (default 24 h)", async ({
    app,
    clock,
  }) => {
    const { executionId: rootExecutionId } = await execute(app, FarParentWorkflowStart, {
      text: "go",
    });
    const tree = { tenantId: "default", rootExecutionId };

    await clock.advance(hours(23));
    const kept = await app.leaseEventsOf(tree);
    await clock.advance(hours(1));
    await clock.advance(seconds(31));

    expect(kept).toHaveLength(1);
    expect(await app.leaseEventsOf(tree)).toEqual([]);
  });
});

describe("#501: what never reaches the takeover", () => {
  throwing(
    "an observer that throws: a warning, the next observer still hears it, the row is kept and the recovery goes on",
    async ({ apps, clock, leases }) => {
      const { call } = await takenOver(apps, clock, leases);

      const rows = await instance(apps, 1).leaseEventsOf({
        tenantId: "default",
        rootExecutionId: zombieRoot(),
      });

      expect(rows).toHaveLength(1);
      expect(leaseSeen.takeovers).toHaveLength(1);
      expect(recovery.ends).toHaveLength(1);
      expect(logged.map((entry) => entry.code)).toContain("observer.failed");
      leases.resume(instance(apps, 0));
      await letZombieGo(apps, call);
    },
  );

  down(
    "a lease log that is down: a warning, the observers still hear it and the recovery goes on",
    async ({ apps, clock, leases }) => {
      const { call } = await takenOver(apps, clock, leases);

      expect(leaseSeen.takeovers).toHaveLength(1);
      expect(recovery.ends).toHaveLength(1);
      expect(logged.filter((entry) => entry.code === "lease-event.failed")).toHaveLength(1);
      expect(
        await instance(apps, 1).leaseEventsOf({
          tenantId: "default",
          rootExecutionId: zombieRoot(),
        }),
      ).toEqual([]);
      leases.resume(instance(apps, 0));
      await letZombieGo(apps, call);
    },
  );

  silent(
    "a lease store that does not name the previous holder: still a Recovered takeover, without previousHolderInstanceId",
    async ({ apps, clock, leases }) => {
      const { call } = await takenOver(apps, clock, leases);

      expect(leaseSeen.takeovers).toHaveLength(1);
      expect(leaseSeen.takeovers[0]).toMatchObject({
        reason: LeaseTakeoverReason.Recovered,
        token: 2,
        holderInstanceId: "instance-2",
      });
      expect(leaseSeen.takeovers[0]).not.toHaveProperty("previousHolderInstanceId");
      expect(leaseSeen.takeovers[0]).not.toHaveProperty("previousToken");
      leases.resume(instance(apps, 0));
      await letZombieGo(apps, call);
    },
  );
});
