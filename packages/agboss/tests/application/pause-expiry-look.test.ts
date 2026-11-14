/**
 * #941: the expiry look of the pause timers on its own — a page of due pauses read at the clock's
 * now, grouped by their tree's root (a tree with 60 due pauses is one take), each root expired by
 * the workflow its record names; a root with no record or no workflow here is skipped, a root that
 * fails is told and the others go on, a stop ends the look between two roots. Each root's expiry
 * is started, not awaited (#1071), at most `maxConcurrentSteps` at once; a look pages through the
 * due pauses with a keyset cursor, so pauses nobody can move do not hide the ones behind them
 * (#1070, #1072).
 */
import { describe, expect, it, vi } from "vitest";
import { EXPIRY_PAGE, ExpiryLook } from "../../src/application/pause-expiry-look.js";

const due = (tenantId: string, rootExecutionId: string, pauseId: string) =>
  ({ tenantId, rootExecutionId, pauseId }) as never;

function look(
  pauses: readonly unknown[],
  extra: { signal?: AbortSignal; capacity?: { maxConcurrentSteps: number } } = {},
) {
  const find = vi.fn((..._args: unknown[]) => Promise.resolve(pauses));
  const expired: string[] = [];
  const expire = vi.fn((record: { runId: string }) => {
    expired.push(record.runId);
    return Promise.resolve();
  });
  const warn = vi.fn();
  const records = {
    findByTenantIdAndRunId: vi.fn((tenantId: string, runId: string) =>
      Promise.resolve(
        runId === "orphan" || runId.startsWith("foreign")
          ? undefined
          : { tenantId, runId, bundle: "desk-workflow" },
      ),
    ),
  };
  const sources = {
    pauses: { findPendingByExpiresAtBefore: find },
    records,
    expiries: new Map([["desk-workflow", expire as never]]),
    clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
    log: { warn },
    signal: extra.signal ?? new AbortController().signal,
    capacity: extra.capacity,
  };
  const looked = new ExpiryLook(sources as never);
  /** One look, then the expiries it started. */
  const run = async () => {
    await looked.run();
    await looked.settled();
  };
  return { sources: sources as never, find, expire, expired, warn, records, looked, run };
}

describe("#941: the expiry look", () => {
  it("reads a page of due pauses at the clock's now", async () => {
    const { find, run } = look([]);

    await run();

    expect(find).toHaveBeenCalledWith(new Date("2026-01-01T00:00:00.000Z"), EXPIRY_PAGE, undefined);
    expect(EXPIRY_PAGE).toBe(50);
  });

  it("groups the pauses by their root: one expiry per tree, whatever its number of due pauses", async () => {
    const { expired, run } = look([
      due("acme", "root-1", "p-1"),
      due("acme", "root-1", "p-2"),
      due("acme", "root-2", "p-3"),
      due("globex", "root-1", "p-4"),
    ]);

    await run();

    expect(expired).toEqual(["root-1", "root-2", "root-1"]);
  });

  it("a root with no record (another application's tree) or no workflow here is skipped", async () => {
    const { expire, run } = look([due("acme", "orphan", "p-1")]);

    await run();

    expect(expire).not.toHaveBeenCalled();
  });

  it("a root that fails is told (pause.expiry-failed, its ids) and the next goes on", async () => {
    const { expire, warn, run } = look([
      due("acme", "root-1", "p-1"),
      due("acme", "root-2", "p-2"),
    ]);
    expire.mockRejectedValueOnce(new Error("the store is down"));

    await run();

    expect(expire).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith("pause.expiry-failed", expect.stringContaining("root-1"), {
      tenantId: "acme",
      executionId: "root-1",
    });
  });

  it("a stop ends the look: no root is started once the signal is aborted", async () => {
    const stop = new AbortController();
    const { expire, run } = look([due("acme", "root-1", "p-1"), due("acme", "root-2", "p-2")], {
      signal: stop.signal,
    });
    stop.abort();

    await run();

    expect(expire).not.toHaveBeenCalled();
  });

  it("a root cut by the stop is not reported as failed: its pause stays pending for the next look", async () => {
    const stop = new AbortController();
    const { expire, warn, run } = look([due("acme", "root-1", "p-1")], { signal: stop.signal });
    expire.mockImplementationOnce(() => {
      stop.abort();
      return Promise.reject(new Error("interrupted"));
    });

    await run();

    expect(warn).not.toHaveBeenCalled();
  });

  it("#1071: the look does not wait for an expiry: it returns while the root's expiry still runs, and `settled` waits for it", async () => {
    const { looked, expire } = look([due("acme", "root-1", "p-1"), due("acme", "root-2", "p-2")]);
    let finish: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => {
      finish = resolve;
    });
    expire.mockImplementation(() => slow);

    await looked.run();

    // both expiries were started and neither ended: the look came back anyway
    expect(expire).toHaveBeenCalledTimes(2);
    let isSettled = false;
    const settled = looked.settled().then(() => {
      isSettled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(isSettled).toBe(false);
    finish();
    await settled;
    expect(isSettled).toBe(true);
  });

  it("#1071: a root whose expiry is still running is not started again by the next look", async () => {
    const { looked, expire } = look([due("acme", "root-1", "p-1")]);
    expire.mockImplementation(() => new Promise<void>(() => undefined));

    await looked.run();
    await looked.run();

    expect(expire).toHaveBeenCalledOnce();
  });

  it("#1071: at most maxConcurrentSteps expiries are in flight; the look goes on from where it stopped", async () => {
    const pauses = [
      due("acme", "root-1", "p-1"),
      due("acme", "root-2", "p-2"),
      due("acme", "root-3", "p-3"),
    ];
    const { looked, find, expired, expire } = look(pauses, { capacity: { maxConcurrentSteps: 2 } });
    const finishers: (() => void)[] = [];
    expire.mockImplementation(
      (record: { runId: string }) =>
        new Promise<void>((resolve) => {
          expired.push(record.runId);
          finishers.push(resolve);
        }),
    );
    // the store pages by keyset: what follows `after`
    find.mockImplementation((...args: unknown[]) => {
      const after = args[2] as { pauseId: string } | undefined;
      const from =
        after === undefined
          ? 0
          : pauses.findIndex((p) => (p as never as { pauseId: string }).pauseId === after.pauseId) +
            1;
      return Promise.resolve(pauses.slice(from));
    });

    await looked.run();
    await new Promise((resolve) => setImmediate(resolve));
    expect(finishers).toHaveLength(2);

    finishers.forEach((finish) => {
      finish();
    });
    await looked.settled();
    await looked.run();
    await new Promise((resolve) => setImmediate(resolve));

    // the third root, which the cap cut, is started by the next look
    expect(expire).toHaveBeenCalledTimes(3);
  });

  it("#1070 #1072: a full page of pauses nobody moves does not hide the next page: the look goes on past it with a keyset", async () => {
    const stuck = Array.from(
      { length: EXPIRY_PAGE },
      (_, index) =>
        ({
          tenantId: "acme",
          rootExecutionId: `foreign-${String(index)}`,
          pauseId: `s-${String(index).padStart(3, "0")}`,
          expiresAt: "2026-01-01T00:00:00.000Z",
        }) as never,
    );
    const movable = {
      tenantId: "acme",
      rootExecutionId: "root-1",
      pauseId: "z-1",
      expiresAt: "2026-01-01T00:00:01.000Z",
    } as never;
    const { find, expired, run } = look([]);
    find.mockImplementation((...args: unknown[]) => {
      const after = args[2] as { pauseId: string } | undefined;
      return Promise.resolve(after === undefined ? stuck : [movable]);
    });

    await run();

    expect(find).toHaveBeenCalledTimes(2);
    expect(find).toHaveBeenLastCalledWith(expect.any(Date), EXPIRY_PAGE, {
      at: "2026-01-01T00:00:00.000Z",
      tenantId: "acme",
      pauseId: `s-${String(EXPIRY_PAGE - 1).padStart(3, "0")}`,
    });
    expect(expired).toEqual(["root-1"]);
  });

  it("#1070: the next look starts again from the beginning when the sweep ended", async () => {
    const { find, run } = look([due("acme", "root-1", "p-1")]);

    await run();
    await run();

    expect(find).toHaveBeenNthCalledWith(1, expect.any(Date), EXPIRY_PAGE, undefined);
    expect(find).toHaveBeenNthCalledWith(2, expect.any(Date), EXPIRY_PAGE, undefined);
  });
});
