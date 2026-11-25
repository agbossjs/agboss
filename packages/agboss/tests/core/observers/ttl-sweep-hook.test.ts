/**
 * #1343: `onTtlSweep` — told by the retention sweep at the end of each look that had rows to
 * remove: what each kind lost (the stores that count give the number), how long the look took and
 * which store failed (by its error's class and code, never its text); a look with nothing to remove
 * tells nothing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecutionObserverManager } from "../../../src/core/observer-manager.js";
import { InMemoryPausedExecutionRepository } from "../../../src/infrastructure/in-memory-paused-execution.repository.js";
import { startRecoverySweep, type RecoverySweep } from "../../../src/infrastructure/recovery.js";
import type { TtlSweepEvent } from "../../../src/index.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { hours, seconds } from "../../../src/units/index.js";

let sweep: RecoverySweep | undefined;

afterEach(async () => {
  await sweep?.stop();
  sweep = undefined;
});

const SECRET = "db-password-hunter2";

function sweepWith(
  expiries: readonly {
    what: string;
    remove: () => Promise<number>;
    retention: number;
  }[],
  told: TtlSweepEvent[],
): { readonly clock: VirtualClock } {
  const clock = new VirtualClock(new Date("2026-01-05T09:00:00.000Z"));
  const observer = new ExecutionObserverManager([
    {
      onTtlSweep: (event: TtlSweepEvent) => {
        told.push(event);
      },
    },
  ]);
  sweep = startRecoverySweep({
    records: { findByStatus: () => Promise.resolve({ items: [] }) } as never,
    workflows: new Map(),
    log: { warn: vi.fn(), error: vi.fn() } as never,
    signal: new AbortController().signal,
    clock,
    pauses: new InMemoryPausedExecutionRepository(),
    pauseRecordRetention: hours(24),
    expiries,
    observer,
  });
  return { clock };
}

describe("#1343: onTtlSweep", () => {
  it("a look tells what each kind lost and which store failed, by class and code", async () => {
    const told: TtlSweepEvent[] = [];
    sweepWith(
      [
        { what: "the kept rows", remove: () => Promise.resolve(3), retention: 0 },
        {
          what: "the broken rows",
          remove: () =>
            Promise.reject(Object.assign(new Error(`cannot connect: ${SECRET}`), { code: "E_DB" })),
          retention: 0,
        },
      ],
      told,
    );

    await vi.waitFor(() => {
      expect(told).toHaveLength(1);
    });

    const [event] = told;
    expect(event?.at).toEqual(new Date("2026-01-05T09:00:00.000Z"));
    expect(event?.durationMs).toBeGreaterThanOrEqual(0);
    expect(event?.categories).toContainEqual({ category: "the kept rows", removed: 3 });
    expect(event?.categories).toContainEqual({
      category: "the broken rows",
      removed: undefined,
      error: { name: "Error", code: "E_DB" },
    });
    expect(JSON.stringify(event)).not.toContain(SECRET);
  });

  it("the next look is told again, on the clock's thirty seconds", async () => {
    const told: TtlSweepEvent[] = [];
    const { clock } = sweepWith(
      [{ what: "the kept rows", remove: () => Promise.resolve(1), retention: 0 }],
      told,
    );
    await vi.waitFor(() => {
      expect(told).toHaveLength(1);
    });

    await clock.advance(seconds(30));

    await vi.waitFor(() => {
      expect(told).toHaveLength(2);
    });
  });
});
