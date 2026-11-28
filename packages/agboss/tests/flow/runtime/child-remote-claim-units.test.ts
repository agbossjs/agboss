/**
 * #1356 (mutation shard `once-child`): the claim timeout of an `OtherWorker` child on its own — when a parent gives its
 * child up (only an `OtherWorker` child that is still queued, once it waited the timeout, and only if the queue still
 * has it to withdraw), what the parent's step fails with, and the claim that won the race, which the parent reads again.
 */
import { describe, expect, it, vi } from "vitest";
import { StepError } from "../../../src/core/error-families/step-errors.js";
import { ChildPlacement } from "../../../src/flow/child-placement.js";
import { lostToClaim } from "../../../src/flow/runtime/remote/remote-claim.js";
import { ExecutionRecordStatus } from "../../../src/infrastructure/execution-record.repository.js";

const NOW = new Date("2026-01-01T00:00:10.000Z");

const siteOf = (
  withdraw: (tenant: string, execution: string) => Promise<boolean>,
  changes: Record<string, unknown> = {},
) =>
  ({
    placement: ChildPlacement.OtherWorker,
    tenantId: "acme",
    executionId: "child-1",
    workflow: "vendor-check-workflow",
    children: {
      clock: { now: () => NOW },
      claimTimeout: 5000,
      queue: { withdrawByTenantIdAndExecutionIdIfQueued: withdraw },
    },
    ...changes,
  }) as never;

const rowOf = (queuedAt: Date, status = ExecutionRecordStatus.Queued) =>
  ({ status, queuedAt }) as never;

const failureOf = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

describe("#1286 D9: the claim timeout of an OtherWorker child", () => {
  it.each([
    [ChildPlacement.AnyWorker],
    [ChildPlacement.CurrentProcess],
    [ChildPlacement.IsolatedWorker],
  ])("a child of placement %s is never given up", async (placement) => {
    const withdraw = vi.fn(() => Promise.resolve(true));

    const lost = await lostToClaim(siteOf(withdraw, { placement }), rowOf(new Date(0)));

    expect(lost).toBe(false);
    expect(withdraw).not.toHaveBeenCalled();
  });

  it.each([
    [ExecutionRecordStatus.Running],
    [ExecutionRecordStatus.Answered],
    [ExecutionRecordStatus.Paused],
  ])("a child that is %s, no longer queued, is not withdrawn", async (status) => {
    const withdraw = vi.fn(() => Promise.resolve(true));

    const lost = await lostToClaim(siteOf(withdraw), rowOf(new Date(0), status));

    expect(lost).toBe(false);
    expect(withdraw).not.toHaveBeenCalled();
  });

  it("a child that waited less than the timeout is left; one at the timeout, or past it, is withdrawn", async () => {
    const withdraw = vi.fn(() => Promise.resolve(true));
    const queuedAt = (waited: number) => new Date(NOW.getTime() - waited);

    expect(await lostToClaim(siteOf(withdraw), rowOf(queuedAt(4999)))).toBe(false);
    expect(withdraw).not.toHaveBeenCalled();
    expect(await failureOf(lostToClaim(siteOf(withdraw), rowOf(queuedAt(5000))))).toBeInstanceOf(
      StepError.ChildWorkerUnavailable,
    );
    expect(await failureOf(lostToClaim(siteOf(withdraw), rowOf(queuedAt(9000))))).toBeInstanceOf(
      StepError.ChildWorkerUnavailable,
    );
    expect(withdraw).toHaveBeenCalledTimes(2);
    expect(withdraw).toHaveBeenCalledWith("acme", "child-1");
  });

  it("a claim that won the race is the parent's to read again: true, nothing thrown", async () => {
    const withdraw = vi.fn(() => Promise.resolve(false));

    expect(await lostToClaim(siteOf(withdraw), rowOf(new Date(NOW.getTime() - 6000)))).toBe(true);
    expect(withdraw).toHaveBeenCalledWith("acme", "child-1");
  });

  it("a child that was withdrawn fails its parent's step, naming the child, the workflow and the wait", async () => {
    const withdraw = vi.fn(() => Promise.resolve(true));

    const error = await failureOf(
      lostToClaim(siteOf(withdraw), rowOf(new Date(NOW.getTime() - 6000))),
    );

    expect(error).toBeInstanceOf(StepError.ChildWorkerUnavailable);
    expect(error).toMatchObject({
      childExecutionId: "child-1",
      workflow: "vendor-check-workflow",
      waitedMs: 6000,
      message:
        'Child workflow "vendor-check-workflow" (execution child-1) was claimed by no other worker in 6000 ms: ChildPlacement.OtherWorker never runs on the instance that launched it',
      details: { childExecutionId: "child-1", workflow: "vendor-check-workflow", waitedMs: 6000 },
    });
  });
});
