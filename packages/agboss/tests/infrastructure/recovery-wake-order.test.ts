/**
 * #1187 (trap 4) — the sweep's order: its look at the open pauses runs before its look at the
 * `running` records, so a `paused` root it wakes beside an untaken answer is recovered in the same
 * sweep, never one sweep (30 s) later.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryPausedExecutionRepository } from "../../src/infrastructure/in-memory-paused-execution.repository.js";
import { NO_RECIPIENTS } from "../../src/infrastructure/pause-record.js";
import { startRecoverySweep, type RecoverySweep } from "../../src/infrastructure/recovery.js";
import { APPROVED_BY_MANAGER, pauseOf } from "../../src/testing/contracts/paused-execution-data.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { hours } from "../../src/units/index.js";
import type { Turn } from "../../src/turns/index.js";

const recordOf = (status: string): Turn =>
  ({
    id: "turn-1",
    runId: "run-1",
    threadId: "thread-1",
    tenantId: "default",
    workflow: "orders-workflow",
    status,
  }) as Turn;

let sweep: RecoverySweep | undefined;

afterEach(async () => {
  await sweep?.stop();
  sweep = undefined;
});

describe("#1187: a root the look wakes is recovered in the same sweep", () => {
  it("the first sweep wakes the paused root, then its look at the running records recovers it", async () => {
    const clock = new VirtualClock(new Date("2026-01-05T09:00:00.000Z"));
    const pauses = new InMemoryPausedExecutionRepository();
    await pauses.findOrCreateByStepKey({
      ...pauseOf("p-1", "run-1:clerk-agent:1:call-1"),
      rootExecutionId: "run-1",
    });
    await pauses.resolveByTenantIdAndPauseId(
      "default",
      "p-1",
      APPROVED_BY_MANAGER,
      clock.now(),
      NO_RECIPIENTS,
    );
    const record = { status: "paused" };
    const recovered: string[] = [];
    const recover = vi.fn((turn: Turn) => {
      recovered.push(turn.runId ?? "");
      return Promise.resolve();
    });
    const wake = vi.fn(() => {
      record.status = "running";
      return Promise.resolve(true);
    });
    const records = {
      findByStatus: ({ status }: { status: string }) =>
        Promise.resolve({ items: record.status === status ? [recordOf(status)] : [] }),
      findByTenantIdAndRunId: () => Promise.resolve(recordOf(record.status)),
    };
    const log = { warn: vi.fn(), error: vi.fn() };

    sweep = startRecoverySweep({
      records: records as never,
      workflows: new Map([["orders-workflow", recover]]),
      // no cancel requested: the resting root is not ended (#1152), so it can be woken
      orphans: new Map([["orders-workflow", () => Promise.resolve(false)]]),
      wakes: new Map([["orders-workflow", wake]]),
      log: log as never,
      signal: new AbortController().signal,
      clock,
      pauses,
      pauseRecordRetention: hours(24),
    });
    await vi.waitFor(() => {
      expect(sweep?.lastSweptAt().getTime()).toBeGreaterThanOrEqual(clock.now().getTime());
      expect(wake).toHaveBeenCalledOnce();
    });

    // one sweep: no time has passed — the woken root is already recovered
    await vi.waitFor(() => {
      expect(recovered).toEqual(["run-1"]);
    });
    expect(log.error).not.toHaveBeenCalled();
  });
});
