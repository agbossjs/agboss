/**
 * #501 PR 2 — a step handed over is told and kept: `onStepHandedOver` and a `HandedOver` row of the
 * lease log, once per error at the innermost site (a step, a tool call, a tool interceptor, an
 * undo), written before the moving call rejects. A zombie handed over at its step leaves one; a
 * zombie that never reached a step again leaves none — the new holder's takeover is there in both.
 * The hand-over itself is unchanged (#471): no `.onError`, no `onExecutionError`.
 */
import { afterEach, beforeEach, describe, expect } from "vitest";
import {
  ExecutionFencedError,
  ExecutionLeaseEventKind,
  HandOverReason,
  HandOverSite,
  LeaseTakeoverReason,
} from "../../src/index.js";
import { exportedRecordLine } from "../../src/infrastructure/execution-history-export.js";
import { ExecutionHistoryRepository } from "../../src/infrastructure/execution-history.repository.js";
import { callTool, testWith } from "../../src/testing/index.js";
import { logged, resetLogged } from "../helpers/log.js";
import { execute } from "../helpers/flow.js";
import { resetRecovery, seen as recovery } from "../infrastructure/fixtures/recovery.workflow.js";
import { instance, rejectionOf, settle, takenOver } from "./fixtures/fence-takeover.js";
import {
  AgentReleaseWorkflowStart,
  BookedReleaseWorkflowStart,
  levers,
  ReleaseAgent,
  ReleaseWorkflowStart,
  resetFence,
  seen,
  StageTool,
} from "./fixtures/fence.workflow.js";
import {
  DownLeaseLogApplication,
  KeptLeaseEventsApplication,
  LeaseEventsApplication,
  leaseSeen,
  resetLeaseEvents,
  ThrowingLeaseObserverApplication,
} from "./fixtures/lease-events.application.js";

const test = testWith(LeaseEventsApplication);
const two = testWith(LeaseEventsApplication, { instances: 2 });
const throwing = testWith(ThrowingLeaseObserverApplication);
const down = testWith(DownLeaseLogApplication);
const kept = testWith(KeptLeaseEventsApplication, { instances: 2 });

beforeEach(() => {
  resetFence();
  resetRecovery();
  resetLeaseEvents();
  resetLogged();
});

afterEach(() => {
  levers.letGo?.();
});

/** The root of the first release (its fence's execution). */
const firstRoot = (): string => seen.fences[0]?.leaseExecutionId ?? "";

describe("#501 AC2: a zombie handed over at a step leaves evidence; one that never got there leaves none", () => {
  two(
    "AC2: a zombie that dies before any write leaves no HandedOver row — only the new holder's takeover",
    async ({ apps, clock, leases }) => {
      const { call } = await takenOver(apps, clock, leases);
      call.catch(() => undefined);

      const rows = await instance(apps, 1).leaseEventsOf({
        tenantId: "default",
        rootExecutionId: firstRoot(),
      });

      expect(rows.map((row) => row.kind)).toEqual([ExecutionLeaseEventKind.Takeover]);
      expect(leaseSeen.handOvers).toEqual([]);
    },
  );

  two(
    "AC2: a zombie refused at its step's write leaves HandedOver(Fenced, Step) after the takeover, written before its call rejects",
    async ({ apps, clock, leases }) => {
      const { call } = await takenOver(apps, clock, leases);
      const rootExecutionId = firstRoot();

      levers.letGo?.();
      await settle();
      leases.resume(instance(apps, 0));
      const error = await rejectionOf(call);
      const rows = await instance(apps, 1).leaseEventsOf({ tenantId: "default", rootExecutionId });

      expect(error).toBeInstanceOf(ExecutionFencedError);
      expect(rows.map((row) => row.kind)).toEqual([
        ExecutionLeaseEventKind.Takeover,
        ExecutionLeaseEventKind.HandedOver,
      ]);
      expect(rows[1]).toEqual({
        kind: ExecutionLeaseEventKind.HandedOver,
        occurredAt: expect.any(String),
        tenantId: "default",
        rootExecutionId,
        executionId: rootExecutionId,
        scopeKey: `default:${rootExecutionId}`,
        token: 1,
        holderInstanceId: "instance-1",
        reason: HandOverReason.Fenced,
        site: HandOverSite.Step,
        step: {
          nodeId: "release-action",
          visitNumber: 1,
          idempotencyKey: `${rootExecutionId}:release-action:1`,
        },
        observedToken: 2,
      });
      expect(leaseSeen.handOvers).toHaveLength(1);
      expect(leaseSeen.handOvers[0]).toMatchObject({
        executionId: rootExecutionId,
        rootExecutionId,
        parentExecutionId: undefined,
        workflow: { name: "release-workflow" },
        step: { nodeId: "release-action", component: { name: "release-action" } },
        reason: HandOverReason.Fenced,
        site: HandOverSite.Step,
        token: 1,
        observedToken: 2,
        holderInstanceId: "instance-1",
      });
      // regression #471: still a hand-over — no onExecutionError, the recovery's end only
      expect(recovery.errors).toEqual([]);
    },
  );

  two(
    "its held timers fire first: its lease is lost here, and the late write is still one hand-over at its step",
    async ({ apps, clock, leases }) => {
      const { call } = await takenOver(apps, clock, leases);

      leases.resume(instance(apps, 0));
      await settle();
      levers.letGo?.();
      await rejectionOf(call);
      await settle();
      const rows = await instance(apps, 1).leaseEventsOf({
        tenantId: "default",
        rootExecutionId: firstRoot(),
      });

      const handOvers = rows.filter((row) => row.kind === ExecutionLeaseEventKind.HandedOver);
      expect(handOvers).toHaveLength(1);
      expect(handOvers[0]).toMatchObject({ site: HandOverSite.Step, token: 1 });
      expect(leaseSeen.handOvers).toHaveLength(1);
      expect(recovery.errors).toEqual([]);
    },
  );
});

describe("#501: one hand-over, at the innermost site", () => {
  for (const wrap of ["bare", "cause", "aggregate"] as const) {
    test(`a fenced write of an action (${wrap}): one HandedOver(Fenced, Step)`, async ({ app }) => {
      levers.wrap = wrap;

      const error = await rejectionOf(execute(app, ReleaseWorkflowStart, { text: "v1" }));
      const rows = await app.leaseEventsOf({ tenantId: "default", rootExecutionId: firstRoot() });

      expect(error).toBeInstanceOf(ExecutionFencedError);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: ExecutionLeaseEventKind.HandedOver,
        reason: HandOverReason.Fenced,
        site: HandOverSite.Step,
        token: 1,
        observedToken: 2,
      });
    });
  }

  test("a fenced tool call, rethrown through the tool, the loop and the step: one HandedOver(Fenced, Tool) with the call's key", async ({
    app,
    mockLlm,
  }) => {
    levers.wrap = "cause";
    mockLlm(ReleaseAgent).thenReturn(callTool(StageTool, { artifact: "v1" }));

    await rejectionOf(execute(app, AgentReleaseWorkflowStart, { text: "stage v1" }));
    const rows = await app.leaseEventsOf({ tenantId: "default", rootExecutionId: firstRoot() });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      reason: HandOverReason.Fenced,
      site: HandOverSite.Tool,
      step: { nodeId: "release-agent", visitNumber: 1 },
    });
    expect(
      rows[0]?.kind === ExecutionLeaseEventKind.HandedOver && rows[0].step.idempotencyKey,
    ).toBe(seen.fences[0]?.idempotencyKey);
    expect(leaseSeen.handOvers).toHaveLength(1);
    expect(leaseSeen.handOvers[0]?.step.callId).toBeDefined();
  });

  test("a fenced tool interceptor: one HandedOver(Fenced, ToolInterceptor)", async ({
    app,
    mockLlm,
  }) => {
    levers.isInterceptorFenced = true;
    mockLlm(ReleaseAgent).thenReturn(callTool(StageTool, { artifact: "v1" }));

    const error = await rejectionOf(execute(app, AgentReleaseWorkflowStart, { text: "stage v1" }));

    expect(error).toBeInstanceOf(ExecutionFencedError);
    expect(leaseSeen.handOvers.map((event) => [event.reason, event.site])).toEqual([
      [HandOverReason.Fenced, HandOverSite.ToolInterceptor],
    ]);
  });

  test("a fenced undo: one HandedOver(Fenced, Compensation) for the undo action's step", async ({
    app,
  }) => {
    levers.isUndoFenced = true;

    const error = await rejectionOf(execute(app, BookedReleaseWorkflowStart, { text: "v1" }));

    expect(error).toBeInstanceOf(ExecutionFencedError);
    expect(leaseSeen.handOvers.map((event) => [event.site, event.step.nodeId])).toEqual([
      [HandOverSite.Compensation, "unbook-action"],
    ]);
    expect(leaseSeen.handOvers[0]?.step.idempotencyKey).toMatch(/:compensation$/);
  });

  test("a step that fails for itself is no hand-over: no row", async ({ app }) => {
    levers.isRefused = true;

    const result = await execute(app, ReleaseWorkflowStart, { text: "v1" });

    expect(result.finish).toMatchObject({ name: "not-released-workflow-finish" });
    expect(
      await app.leaseEventsOf({ tenantId: "default", rootExecutionId: result.executionId }),
    ).toEqual([]);
    expect(leaseSeen.handOvers).toEqual([]);
  });
});

describe("#501: what never reaches the hand-over", () => {
  throwing(
    "an observer that throws: a warning; the call still rejects with the fenced error and the row is kept",
    async ({ app }) => {
      levers.wrap = "bare";

      const error = await rejectionOf(execute(app, ReleaseWorkflowStart, { text: "v1" }));

      expect(error).toBeInstanceOf(ExecutionFencedError);
      expect(
        await app.leaseEventsOf({ tenantId: "default", rootExecutionId: firstRoot() }),
      ).toHaveLength(1);
      expect(leaseSeen.handOvers).toHaveLength(1);
      expect(logged.map((entry) => entry.code)).toContain("observer.failed");
      expect(recovery.errors).toEqual([]);
    },
  );

  down(
    "a lease log that is down: a warning; the observers still hear it, the call still rejects with the fenced error",
    async ({ app }) => {
      levers.wrap = "bare";

      const error = await rejectionOf(execute(app, ReleaseWorkflowStart, { text: "v1" }));

      expect(error).toBeInstanceOf(ExecutionFencedError);
      expect(leaseSeen.handOvers).toHaveLength(1);
      expect(logged.filter((entry) => entry.code === "lease-event.failed")).toHaveLength(1);
    },
  );
});

describe("#501 AC1: the execution's history shows the lease log", () => {
  kept(
    "AC1: the recovered root's kept record carries its takeover, and so does its exported line",
    async ({ apps, clock, leases }) => {
      const { call } = await takenOver(apps, clock, leases);
      call.catch(() => undefined);
      const b = instance(apps, 1);
      const history = b.resolve(ExecutionHistoryRepository);

      const record = await history.findByTenantIdAndExecutionId("default", firstRoot());
      if (record === undefined) throw new Error("the recovered root's record is kept");
      const line: unknown = JSON.parse(exportedRecordLine(record));

      expect(record.leaseEvents).toEqual([
        expect.objectContaining({
          kind: ExecutionLeaseEventKind.Takeover,
          reason: LeaseTakeoverReason.Recovered,
          token: 2,
          holderInstanceId: "instance-2",
          previousHolderInstanceId: "instance-1",
        }),
      ]);
      expect(line).toMatchObject({ leaseEvents: record.leaseEvents });
    },
  );
});
