/**
 * #501 PR 2 — the hand-over's record, unit by unit: `recordedHandOver` records once per error and
 * lease scope, at the first site with a frame and a lease that records (so the sites a hand-over is
 * rethrown through record nothing); `handOverEventOf` names why and with which tokens; the recording
 * never throws; a held lease's `LeaseEventReports` is settled only once its rows are written.
 */
import { describe, expect, it } from "vitest";
import { ApplicationStoppingError } from "../../src/core/errors.js";
import { recordedHandOver } from "../../src/app/handed-over.js";
import {
  fencedEffectEventOf,
  handOverEventOf,
  recordFencedEffect,
  recordHandOver,
  type FencedEffectReport,
  type HandOverReport,
} from "../../src/app/lease-events.js";
import { ExecutionFencedError, ExecutionLeaseLostError } from "../../src/app/lease-lost.js";
import { LeaseEventReports, type LeaseEventLog } from "../../src/app/execution-leases.js";
import { ExecutionObserverManager } from "../../src/core/observer-manager.js";
import { runInFrame, type FrameLease, type FrameSpec } from "../../src/flow/context/frame.js";
import { nodeEventOf } from "../../src/flow/observers/execution-event.js";
import type { StepHandedOverEvent } from "../../src/flow/observers/lease-events.js";
import type { ExecutionLease } from "../../src/infrastructure/execution-lease.repository.js";
import {
  ExecutionLeaseEventKind,
  FencedEffectEventOutcome,
  HandOverReason,
  HandOverSite,
  InMemoryExecutionLeaseEventRepository,
} from "../../src/infrastructure/execution-lease-event.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { testFrame } from "../helpers/frame.js";
import { recordingLog } from "../helpers/log.js";

/** A lease of `scopeKey` that keeps every report it is asked to record. */
function recordingLease(scopeKey: string): { lease: FrameLease; reports: HandOverReport[] } {
  const reports: HandOverReport[] = [];
  const lease: FrameLease = {
    ...silentLease(scopeKey),
    recordHandOver: (report) => {
      reports.push(report);
    },
  };
  return { lease, reports };
}

/** A lease of `scopeKey` that records nothing (a unit runner's). */
function silentLease(scopeKey: string): FrameLease {
  return {
    tenantId: "default",
    leaseExecutionId: "execution-1",
    scopeKey,
    token: 1,
    confirmedUntil: Number.POSITIVE_INFINITY,
    isYielded: false,
    assertHeld: () => undefined,
    confirmNow: () => Promise.resolve(),
    enterStep: () => Promise.resolve(() => undefined),
  };
}

/** The test frame, under `lease`. */
const frameUnder = (lease: FrameLease | undefined): FrameSpec => {
  const frame = testFrame();
  return { ...frame, execution: { ...frame.execution, lease } };
};

const lost = (): ExecutionLeaseLostError => new ExecutionLeaseLostError("execution-1");

describe("#501: a hand-over is recorded once, at the innermost site", () => {
  it("records the error with the frame's step and the site, and returns it as it is", () => {
    const { lease, reports } = recordingLease("default:execution-1");
    const frame = frameUnder(lease);
    const error = lost();

    const thrown = recordedHandOver(error, HandOverSite.Tool, frame);

    expect(thrown).toBe(error);
    expect(reports).toEqual([{ event: nodeEventOf(frame), error, site: HandOverSite.Tool }]);
  });

  it("the same error rethrown through outer sites is recorded once", () => {
    const { lease, reports } = recordingLease("default:execution-1");
    const frame = frameUnder(lease);
    const error = lost();

    recordedHandOver(error, HandOverSite.Tool, frame);
    recordedHandOver(error, HandOverSite.Step, frame);

    expect(reports.map((report) => report.site)).toEqual([HandOverSite.Tool]);
  });

  it("one error under two leases (the app's stop of two trees) is recorded for each", () => {
    const first = recordingLease("default:execution-1");
    const second = recordingLease("default:execution-2");
    const error = new ApplicationStoppingError("the app is stopping");

    recordedHandOver(error, HandOverSite.Step, frameUnder(first.lease));
    recordedHandOver(error, HandOverSite.Step, frameUnder(second.lease));

    expect([first.reports.length, second.reports.length]).toEqual([1, 1]);
  });

  it("nothing without a frame, without a lease, or under a lease that does not record", () => {
    const silent = silentLease("default:execution-1");
    const error = lost();

    expect(recordedHandOver(error, HandOverSite.Branch, undefined)).toBe(error);
    expect(recordedHandOver(error, HandOverSite.Branch, frameUnder(undefined))).toBe(error);
    expect(recordedHandOver(error, HandOverSite.Branch, frameUnder(silent))).toBe(error);
  });

  it("an outer site with a lease still records what an inner site without one could not", () => {
    const { lease, reports } = recordingLease("default:execution-1");
    const error = lost();

    recordedHandOver(error, HandOverSite.Tool, frameUnder(undefined));
    recordedHandOver(error, HandOverSite.Child, frameUnder(lease));

    expect(reports.map((report) => report.site)).toEqual([HandOverSite.Child]);
  });

  it("by default the current frame's step", async () => {
    const { lease, reports } = recordingLease("default:execution-1");
    const frame = frameUnder(lease);

    await runInFrame(frame, () => {
      recordedHandOver(lost(), HandOverSite.Compensation);
      return Promise.resolve();
    });

    expect(reports.map((report) => report.event.step.nodeId)).toEqual([frame.step.nodeId]);
  });
});

const HELD = { scopeKey: "default:execution-1", holderInstanceId: "instance-1", token: 3 };

/** A report of `error` at a tool call of the test frame. */
const reportOf = (error: HandOverReport["error"]): HandOverReport => ({
  event: nodeEventOf(testFrame()),
  error,
  site: HandOverSite.Tool,
});

describe("#501: why a step was handed over, and the tokens its event names", () => {
  it("a fenced write: Fenced, the refused write's own scope and token and the token it met", () => {
    const fenced = new ExecutionFencedError({
      scopeKey: "acme:execution-9",
      token: 1,
      observedToken: 2,
    });

    const event = handOverEventOf(reportOf(fenced), HELD);

    expect(event).toMatchObject({
      reason: HandOverReason.Fenced,
      scopeKey: "acme:execution-9",
      token: 1,
      observedToken: 2,
      site: HandOverSite.Tool,
      holderInstanceId: "instance-1",
    });
  });

  it("a fenced write that does not say what it met has no observedToken", () => {
    const fenced = new ExecutionFencedError({ scopeKey: "acme:execution-9", token: 1 });

    expect(handOverEventOf(reportOf(fenced), HELD)).not.toHaveProperty("observedToken");
  });

  it("a lost lease: LeaseLost, the held lease's scope and token", () => {
    expect(handOverEventOf(reportOf(lost()), HELD)).toMatchObject({
      reason: HandOverReason.LeaseLost,
      scopeKey: "default:execution-1",
      token: 3,
    });
  });

  it("the app's stop: ApplicationStopping", () => {
    const event = handOverEventOf(reportOf(new ApplicationStoppingError("stopping")), HELD);

    expect(event.reason).toBe(HandOverReason.ApplicationStopping);
  });

  it("keeps the node event's shape: a root's parentExecutionId is there, undefined", () => {
    const event = handOverEventOf(reportOf(lost()), HELD);

    expect(Object.keys(event)).toContain("parentExecutionId");
    expect(event.parentExecutionId).toBeUndefined();
  });
});

/** A lease log in memory: its rows, what its observer heard, its warnings. */
function handOverLog(overrides: Partial<LeaseEventLog> = {}) {
  const database = new InMemoryDatabase();
  const heard: StepHandedOverEvent[] = [];
  const { log, entries } = recordingLog();
  const events: LeaseEventLog = {
    repository: new InMemoryExecutionLeaseEventRepository(database),
    observer: new ExecutionObserverManager([
      {
        onStepHandedOver: (event: StepHandedOverEvent) => {
          heard.push(event);
        },
      },
    ]),
    mask: (event) => Promise.resolve(event),
    log,
    clock: new VirtualClock(),
    recording: import("../../src/app/lease-events.js"),
    ...overrides,
  };
  return { events, heard, entries, rows: database.executionLeaseEvents };
}

describe("#501: recording a hand-over", () => {
  it("writes the row — the step's join keys only — then tells the observers", async () => {
    const { events, heard, rows } = handOverLog();
    const report = reportOf(lost());

    await recordHandOver(events, report, HELD);

    expect(rows).toEqual([
      {
        kind: ExecutionLeaseEventKind.HandedOver,
        occurredAt: "2026-01-05T09:00:00.000Z",
        tenantId: report.event.tenantId,
        rootExecutionId: report.event.rootExecutionId,
        executionId: report.event.executionId,
        scopeKey: "default:execution-1",
        token: 3,
        holderInstanceId: "instance-1",
        reason: HandOverReason.LeaseLost,
        site: HandOverSite.Tool,
        step: {
          nodeId: report.event.step.nodeId,
          visitNumber: report.event.step.visitNumber,
          idempotencyKey: report.event.step.idempotencyKey,
        },
      },
    ]);
    expect(heard).toEqual([handOverEventOf(report, HELD)]);
  });

  it("a mask that fails: a warning, nothing written, nothing told, no throw", async () => {
    const { events, heard, rows, entries } = handOverLog({
      mask: () => Promise.reject(new Error("the mask failed")),
    });

    await expect(recordHandOver(events, reportOf(lost()), HELD)).resolves.toBeUndefined();

    expect([rows, heard]).toEqual([[], []]);
    expect(entries.map((entry) => entry.code)).toEqual(["lease-event.failed"]);
  });
});

const LEASE: ExecutionLease = {
  tenantId: "default",
  rootExecutionId: "execution-1",
  holderInstanceId: "instance-1",
  leaseEpoch: 2,
  expiresAt: new Date("2026-01-05T09:00:30.000Z"),
};

describe("#501: a held lease's hand-overs", () => {
  it("are written under the token held then; settled() waits for them", async () => {
    const { events, rows } = handOverLog();
    const reports = new LeaseEventReports();
    reports.held(LEASE);
    reports.held({ ...LEASE, leaseEpoch: 3 });

    reports.handOver(events, reportOf(lost()), "default:execution-1");
    await reports.settled();

    expect(rows.map((row) => row.token)).toEqual([3]);
  });

  it("nothing without a lease log, or before any lease is held", async () => {
    const { events, rows } = handOverLog();
    const unheld = new LeaseEventReports();
    const unlogged = new LeaseEventReports();
    unlogged.held(LEASE);

    unheld.handOver(events, reportOf(lost()), "default:execution-1");
    unlogged.handOver(undefined, reportOf(lost()), "default:execution-1");
    await Promise.all([unheld.settled(), unlogged.settled()]);

    expect(rows).toEqual([]);
  });
});

/** A refused call of the effect `charge` at the test frame's step. */
const refusedCharge = (): FencedEffectReport => ({
  event: nodeEventOf(testFrame()),
  name: "charge",
  scopeKey: "default:execution-1",
  token: 1,
  outcome: FencedEffectEventOutcome.Refused,
  observedToken: 2,
});

describe("#501: a fenced effect's call in the lease log", () => {
  it("its event is the step's node event with the call, the instance, and only the tokens it has", () => {
    const event = fencedEffectEventOf(
      {
        ...refusedCharge(),
        outcome: FencedEffectEventOutcome.Ran,
        observedToken: undefined,
        writtenToken: 1,
      },
      "instance-1",
    );

    expect(event).toMatchObject({
      name: "charge",
      token: 1,
      writtenToken: 1,
      holderInstanceId: "instance-1",
    });
    expect(event).not.toHaveProperty("observedToken");
    expect(Object.keys(event)).toContain("parentExecutionId");
  });

  it("a mask that fails: a warning, nothing written, nothing told, no throw", async () => {
    const { events, rows, entries } = handOverLog({
      mask: () => Promise.reject(new Error("the mask failed")),
    });

    await expect(
      recordFencedEffect(events, refusedCharge(), "instance-1"),
    ).resolves.toBeUndefined();

    expect(rows).toEqual([]);
    expect(entries.map((entry) => entry.code)).toEqual(["lease-event.failed"]);
  });

  it("a held lease writes its events in the order recorded: the refusal before its hand-over", async () => {
    const { events, rows } = handOverLog();
    const reports = new LeaseEventReports();
    reports.held(LEASE);

    reports.fencedEffect(events, refusedCharge());
    reports.handOver(events, reportOf(lost()), "default:execution-1");
    await reports.settled();

    expect(rows.map((row) => row.kind)).toEqual([
      ExecutionLeaseEventKind.FencedEffect,
      ExecutionLeaseEventKind.HandedOver,
    ]);
  });

  it("nothing before any lease is held, or without a lease log", async () => {
    const { events, rows } = handOverLog();
    const unheld = new LeaseEventReports();
    const unlogged = new LeaseEventReports();
    unlogged.held(LEASE);

    unheld.fencedEffect(events, refusedCharge());
    unlogged.fencedEffect(undefined, refusedCharge());
    await Promise.all([unheld.settled(), unlogged.settled()]);

    expect(rows).toEqual([]);
  });
});
