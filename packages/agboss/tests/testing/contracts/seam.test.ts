/**
 * #481: the lifecycle of one published contract case (`withTarget`) — the suite's clock, then
 * `reset()`, two `instance()` calls on two seams, the case, a `close()` per built store; sync and
 * async targets, a target without `reset` / `close`, and every way it can fail: the error that
 * fails the case is the first one that happened.
 */
import { describe, expect, it } from "vitest";
import {
  withTarget,
  type ContractTarget,
  type StoreSeam,
} from "../../../src/testing/contracts/seam.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { seconds } from "../../../src/units/index.js";

/** A store of the tests below: which instance built it. */
interface Built {
  readonly seam: StoreSeam;
}

/** A target that logs what the lifecycle calls, with `overrides` over it. */
function loggingTarget(
  log: string[],
  overrides: Partial<ContractTarget<Built>> = {},
): ContractTarget<Built> {
  return {
    name: "logging",
    reset: () => {
      log.push("reset");
    },
    instance: (seam) => {
      log.push(`instance ${seam.instanceId}`);
      return { seam };
    },
    close: (store) => {
      log.push(`close ${store.seam.instanceId}`);
    },
    ...overrides,
  };
}

describe("#481: one case's lifecycle", () => {
  it("reset, two instances, the case, then a close per instance — in that order", async () => {
    const log: string[] = [];

    await withTarget(loggingTarget(log), async () => {
      log.push("case");
    })();

    expect(log).toEqual([
      "reset",
      "instance instance-1",
      "instance instance-2",
      "case",
      "close instance-1",
      "close instance-2",
    ]);
  });

  it("both seams share the suite's VirtualClock at 2026-01-05T09:00:00Z; each has its own identity", async () => {
    const seen: StoreSeam[] = [];

    await withTarget(loggingTarget([]), async ({ clock, first, second }) => {
      seen.push(first.seam, second.seam);
      expect(clock).toBeInstanceOf(VirtualClock);
      expect(first.seam.clock).toBe(clock);
      expect(second.seam.clock).toBe(clock);
      expect(clock.now()).toEqual(new Date("2026-01-05T09:00:00.000Z"));
    })();

    expect(seen.map((seam) => seam.instanceId)).toEqual(["instance-1", "instance-2"]);
    expect(seen.map((seam) => seam.application.instanceId)).toEqual(["instance-1", "instance-2"]);
    expect(seen[0]?.application.environmentName).toBe("test");
  });

  it("every case starts on a new clock: time moved by one case does not reach the next", async () => {
    const target = loggingTarget([]);
    const starts: Date[] = [];
    const body = async ({ clock }: { readonly clock: VirtualClock }): Promise<void> => {
      starts.push(clock.now());
      await clock.advance(seconds(90));
    };

    await withTarget(target, body)();
    await withTarget(target, body)();

    expect(starts).toEqual([
      new Date("2026-01-05T09:00:00.000Z"),
      new Date("2026-01-05T09:00:00.000Z"),
    ]);
  });

  it("an async instance and an async reset are awaited before the case", async () => {
    const log: string[] = [];
    const later = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
    const target = loggingTarget(log, {
      reset: async () => {
        await later();
        log.push("reset");
      },
      instance: async (seam) => {
        await later();
        log.push(`instance ${seam.instanceId}`);
        return { seam };
      },
    });

    await withTarget(target, async ({ second }) => {
      log.push(`case on ${second.seam.instanceId}`);
    })();

    expect(log.slice(0, 4)).toEqual([
      "reset",
      "instance instance-1",
      "instance instance-2",
      "case on instance-2",
    ]);
  });

  it("a target with no reset and no close: only its instances are built", async () => {
    const log: string[] = [];
    const target: ContractTarget<Built> = {
      name: "bare",
      instance: (seam) => {
        log.push(seam.instanceId);
        return { seam };
      },
    };

    await withTarget(target, async () => undefined)();

    expect(log).toEqual(["instance-1", "instance-2"]);
  });

  it("an async close is awaited before the case resolves", async () => {
    const log: string[] = [];
    const target = loggingTarget(log, {
      close: async (store) => {
        await new Promise((resolve) => setImmediate(resolve));
        log.push(`closed ${store.seam.instanceId}`);
      },
    });

    await withTarget(target, async () => undefined)();

    expect(log.slice(-2)).toEqual(["closed instance-1", "closed instance-2"]);
  });
});

describe("#481: a failing lifecycle fails the case with the first error", () => {
  it("reset throwing: the case fails with that error, and nothing is built or run", async () => {
    const log: string[] = [];
    const target = loggingTarget(log, {
      reset: () => {
        throw new Error("the schema could not be truncated");
      },
    });

    await expect(
      withTarget(target, async () => {
        log.push("case");
      })(),
    ).rejects.toThrow("the schema could not be truncated");
    expect(log).toEqual([]);
  });

  it("an async reset rejecting: the same", async () => {
    const target = loggingTarget([], { reset: () => Promise.reject(new Error("no database")) });

    await expect(withTarget(target, async () => undefined)()).rejects.toThrow("no database");
  });

  it("the second instance failing: the first is closed, the case does not run", async () => {
    const log: string[] = [];
    const target = loggingTarget(log, {
      instance: (seam) => {
        if (seam.instanceId === "instance-2") throw new Error("no second connection");
        log.push(`instance ${seam.instanceId}`);
        return { seam };
      },
    });

    await expect(
      withTarget(target, async () => {
        log.push("case");
      })(),
    ).rejects.toThrow("no second connection");
    expect(log).toEqual(["reset", "instance instance-1", "close instance-1"]);
  });

  it("the case failing: both stores are closed, and the case's error is the one reported", async () => {
    const log: string[] = [];
    const target = loggingTarget(log, {
      close: (store) => {
        log.push(`close ${store.seam.instanceId}`);
        throw new Error("close failed too");
      },
    });

    await expect(
      withTarget(target, async () => {
        throw new Error("the rule is broken");
      })(),
    ).rejects.toThrow("the rule is broken");
    expect(log).toEqual([
      "reset",
      "instance instance-1",
      "instance instance-2",
      "close instance-1",
      "close instance-2",
    ]);
  });

  it("a close failing after a passing case fails it with the close's error; the other store is still closed", async () => {
    const log: string[] = [];
    const target = loggingTarget(log, {
      close: (store) => {
        log.push(`close ${store.seam.instanceId}`);
        if (store.seam.instanceId === "instance-1") throw new Error("connection 1 would not close");
      },
    });

    await expect(withTarget(target, async () => undefined)()).rejects.toThrow(
      "connection 1 would not close",
    );
    expect(log.slice(-2)).toEqual(["close instance-1", "close instance-2"]);
  });
});
