/**
 * #941: the expiry look of the pause timers on its own — a page of due pauses read at the clock's
 * now, grouped by their tree's root (a tree with 60 due pauses is one take), each root expired by
 * the workflow its record names; a root with no record or no workflow here is skipped, a root that
 * fails is told and the others go on, a stop ends the look between two roots.
 */
import { describe, expect, it, vi } from "vitest";
import { EXPIRY_PAGE, lookForExpiredPauses } from "../../src/application/pause-expiry-look.js";

const due = (tenantId: string, rootExecutionId: string, pauseId: string) =>
  ({ tenantId, rootExecutionId, pauseId }) as never;

function look(pauses: readonly unknown[], extra: { signal?: AbortSignal } = {}) {
  const find = vi.fn(() => Promise.resolve(pauses));
  const expired: string[] = [];
  const expire = vi.fn((record: { runId: string }) => {
    expired.push(record.runId);
    return Promise.resolve();
  });
  const warn = vi.fn();
  const records = {
    findByTenantIdAndRunId: vi.fn((tenantId: string, runId: string) =>
      Promise.resolve(
        runId === "orphan" ? undefined : { tenantId, runId, bundle: "desk-workflow" },
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
  };
  return { sources: sources as never, find, expire, expired, warn, records };
}

describe("#941: the expiry look", () => {
  it("reads a page of due pauses at the clock's now", async () => {
    const { sources, find } = look([]);

    await lookForExpiredPauses(sources);

    expect(find).toHaveBeenCalledWith(new Date("2026-01-01T00:00:00.000Z"), EXPIRY_PAGE);
    expect(EXPIRY_PAGE).toBe(50);
  });

  it("groups the pauses by their root: one expiry per tree, whatever its number of due pauses", async () => {
    const { sources, expired } = look([
      due("acme", "root-1", "p-1"),
      due("acme", "root-1", "p-2"),
      due("acme", "root-2", "p-3"),
      due("globex", "root-1", "p-4"),
    ]);

    await lookForExpiredPauses(sources);

    expect(expired).toEqual(["root-1", "root-2", "root-1"]);
  });

  it("a root with no record (another application's tree) or no workflow here is skipped", async () => {
    const { sources, expire } = look([due("acme", "orphan", "p-1")]);

    await lookForExpiredPauses(sources);

    expect(expire).not.toHaveBeenCalled();
  });

  it("a root that fails is told (pause.expiry-failed, its ids) and the next goes on", async () => {
    const { sources, expire, warn } = look([
      due("acme", "root-1", "p-1"),
      due("acme", "root-2", "p-2"),
    ]);
    expire.mockRejectedValueOnce(new Error("the store is down"));

    await lookForExpiredPauses(sources);

    expect(expire).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith("pause.expiry-failed", expect.stringContaining("root-1"), {
      tenantId: "acme",
      executionId: "root-1",
    });
  });

  it("a stop ends the look between two roots", async () => {
    const stop = new AbortController();
    const { sources, expire } = look([due("acme", "root-1", "p-1"), due("acme", "root-2", "p-2")], {
      signal: stop.signal,
    });
    expire.mockImplementationOnce(() => {
      stop.abort();
      return Promise.resolve();
    });

    await lookForExpiredPauses(sources);

    expect(expire).toHaveBeenCalledOnce();
  });

  it("a root cut by the stop is not reported as failed: its pause stays pending for the next look", async () => {
    const stop = new AbortController();
    const { sources, expire, warn } = look([due("acme", "root-1", "p-1")], { signal: stop.signal });
    expire.mockImplementationOnce(() => {
      stop.abort();
      return Promise.reject(new Error("interrupted"));
    });

    await lookForExpiredPauses(sources);

    expect(warn).not.toHaveBeenCalled();
  });
});
