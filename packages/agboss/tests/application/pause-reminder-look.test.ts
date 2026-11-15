/**
 * #942: the reminder look of the pause timers on its own — a sweep of due reminders with a keyset
 * cursor (as the expiry look, #1070, #1072): each written once with the pause's recipients, started
 * and not awaited (#1071), a pause of another application's tree (on a shared store) is passed and
 * never hides the ones behind it, one that fails is told and the others go on, a stop ends the look
 * between two pauses, and the notices written are looked for at once.
 */
import { describe, expect, it, vi } from "vitest";
import { REMINDER_PAGE, ReminderLook } from "../../src/application/pause-reminder-look.js";

const AT = "2026-01-01T00:00:00.000Z";
const minute = (n: number): string =>
  new Date(Date.parse(AT) - 3_600_000 + n * 60_000).toISOString();

interface Due {
  readonly tenantId: string;
  readonly rootExecutionId: string;
  readonly pauseId: string;
  readonly remindAt: string;
}

/** A due pause of a tree: `foreign-…` roots belong to another application's workflow, `orphan` to none. */
const due = (tenantId: string, rootExecutionId: string, pauseId: string, n = 0): Due => ({
  tenantId,
  rootExecutionId,
  pauseId,
  remindAt: minute(n),
});

/** The store's due-scan: ascending by (remindAt, tenant, id), only past `after` — unless told to ignore it. */
function scanOf(pauses: readonly Due[], options: { ignoreAfter?: boolean } = {}) {
  return vi.fn(
    (_at: Date, limit: number, after?: { at: string; tenantId: string; pauseId: string }) => {
      const sorted = [...pauses].sort(
        (a, b) =>
          a.remindAt.localeCompare(b.remindAt) ||
          a.tenantId.localeCompare(b.tenantId) ||
          a.pauseId.localeCompare(b.pauseId),
      );
      const past =
        after === undefined || options.ignoreAfter === true
          ? sorted
          : sorted.filter(
              (pause) =>
                (pause.remindAt.localeCompare(after.at) ||
                  pause.tenantId.localeCompare(after.tenantId) ||
                  pause.pauseId.localeCompare(after.pauseId)) > 0,
            );
      return Promise.resolve(past.slice(0, limit));
    },
  );
}

function look(pauses: readonly Due[], extra: { signal?: AbortSignal; ignoreAfter?: boolean } = {}) {
  const find = scanOf(pauses, extra);
  const remind = vi.fn((..._call: unknown[]) => Promise.resolve(true));
  const warn = vi.fn();
  const delivered = vi.fn();
  const recipientsOf = vi.fn(() => ({ channel: "manager-channel", listeners: ["audit"] }));
  const records = {
    findByTenantIdAndRunId: vi.fn((tenantId: string, runId: string) =>
      Promise.resolve(
        runId === "orphan"
          ? undefined
          : {
              tenantId,
              runId,
              bundle: runId.startsWith("foreign") ? "other-workflow" : "desk-workflow",
            },
      ),
    ),
  };
  const sources = {
    pauses: { findPendingByRemindAtBefore: find, remindByTenantIdAndPauseId: remind },
    records,
    bundles: new Set(["desk-workflow"]),
    recipientsOf,
    delivered,
    clock: { now: () => new Date(AT) },
    log: { warn },
    signal: extra.signal ?? new AbortController().signal,
  };
  const instance = new ReminderLook(sources as never);
  return { instance, find, remind, warn, delivered, recipientsOf };
}

const remindedIds = (remind: { mock: { calls: readonly unknown[][] } }): unknown[] =>
  remind.mock.calls.map((call) => call[1]);

describe("#942: the reminder look", () => {
  it("reads a page of due reminders at the clock's now, from the start", async () => {
    const { instance, find } = look([]);

    await instance.run();

    expect(find).toHaveBeenCalledWith(new Date(AT), REMINDER_PAGE, undefined);
    expect(REMINDER_PAGE).toBe(50);
  });

  it("reminds each due pause once, at the look's now, with its recipients, then looks for the notices", async () => {
    const { instance, remind, recipientsOf, delivered } = look([
      due("acme", "root-1", "p-1", 1),
      due("globex", "root-2", "p-2", 2),
    ]);

    await instance.run();
    await instance.settled();

    const recipients = { channel: "manager-channel", listeners: ["audit"] };
    expect(remind.mock.calls).toEqual([
      ["acme", "p-1", new Date(AT), recipients],
      ["globex", "p-2", new Date(AT), recipients],
    ]);
    expect(recipientsOf).toHaveBeenCalledTimes(2);
    expect(delivered).toHaveBeenCalledTimes(2);
  });

  it("a pause another instance reminded first (the store says no) tells nobody", async () => {
    const { instance, remind, delivered } = look([due("acme", "root-1", "p-1")]);
    remind.mockResolvedValueOnce(false);

    await instance.run();
    await instance.settled();

    expect(delivered).not.toHaveBeenCalled();
  });

  it("a tree with no record, or one of another application's workflow, is left alone", async () => {
    const { instance, remind } = look([
      due("acme", "orphan", "p-1", 1),
      due("acme", "foreign-1", "p-2", 2),
    ]);

    await instance.run();
    await instance.settled();

    expect(remind).not.toHaveBeenCalled();
  });

  it("1070 for reminders: 51 due pauses of another application ahead of one of ours — ours is reminded", async () => {
    const foreign = Array.from({ length: REMINDER_PAGE + 1 }, (_, index) =>
      due("acme", `foreign-${String(index)}`, `f-${String(index).padStart(3, "0")}`, 1),
    );
    const { instance, remind, find } = look([...foreign, due("acme", "root-ours", "ours", 5)]);

    // pauses nobody here can remind take no place of the cap: one look reaches ours
    await instance.run();
    await instance.settled();

    expect(remindedIds(remind)).toEqual(["ours"]);
    expect(find).toHaveBeenLastCalledWith(
      new Date(AT),
      REMINDER_PAGE,
      expect.objectContaining({ pauseId: "f-049" }),
    );
  });

  it.each([200, 1000])(
    "#1092 #1100: %i due pauses of another application ahead of one of ours — ours is reminded by the first look, not ceil(N / 50) ticks later",
    async (count) => {
      const foreign = Array.from({ length: count }, (_, index) =>
        due("acme", `foreign-${String(index)}`, `f-${String(index).padStart(4, "0")}`, 1),
      );
      const { instance, remind } = look([...foreign, due("acme", "root-ours", "ours", 5)]);

      // as the timer calls it: one look per tick, its reminders not awaited
      await instance.run();
      await new Promise((resolve) => setImmediate(resolve));

      expect(remindedIds(remind)).toEqual(["ours"]);
      await instance.settled();
    },
  );

  it("the in-use variant: a reminder still in flight is passed, never started again, and the ones behind it are reached", async () => {
    const { instance, remind } = look([
      due("acme", "root-a", "slow", 1),
      due("acme", "root-b", "next", 2),
    ]);
    let release: () => void = () => undefined;
    remind.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = () => {
            resolve(true);
          };
        }),
    );

    await instance.run();
    await instance.run();

    // the first look started both; the second finds "slow" in flight and starts nothing again
    expect(remindedIds(remind)).toEqual(["slow", "next"]);
    release();
    await instance.settled();
  });

  it("a look hands off: it ends while a reminder is still writing, `settled` waits for it", async () => {
    const { instance, remind, delivered } = look([due("acme", "root-a", "slow", 1)]);
    let release: () => void = () => undefined;
    remind.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = () => {
            resolve(true);
          };
        }),
    );

    await instance.run();
    expect(delivered).not.toHaveBeenCalled();
    const settled = instance.settled();
    release();
    await settled;

    expect(delivered).toHaveBeenCalledOnce();
  });

  it("at most REMINDER_PAGE reminders are in flight: a look cut short by that goes on from where it stopped", async () => {
    const all = Array.from({ length: REMINDER_PAGE + 3 }, (_, index) =>
      due("acme", `root-${String(index)}`, `p-${String(index).padStart(3, "0")}`, 1),
    );
    const { instance, remind } = look(all);
    const releases: (() => void)[] = [];
    remind.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          releases.push(() => {
            resolve(true);
          });
        }),
    );

    await instance.run();
    expect(remind).toHaveBeenCalledTimes(REMINDER_PAGE);
    for (const release of releases.splice(0)) release();
    await instance.settled();
    remind.mockImplementation(() => Promise.resolve(true));
    await instance.run();
    await instance.settled();

    // the second look continued after the 50th: the three left, none twice
    expect(new Set(remindedIds(remind)).size).toBe(REMINDER_PAGE + 3);
    expect(remind).toHaveBeenCalledTimes(REMINDER_PAGE + 3);
  });

  it("a pause that fails is told (pause.reminder-failed, its ids) and the next goes on", async () => {
    const { instance, remind, warn, delivered } = look([
      due("acme", "root-1", "p-1", 1),
      due("acme", "root-2", "p-2", 2),
    ]);
    remind.mockRejectedValueOnce(new Error("the store is down"));

    await instance.run();
    await instance.settled();

    expect(remind).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith("pause.reminder-failed", expect.stringContaining("root-1"), {
      tenantId: "acme",
      executionId: "root-1",
    });
    expect(delivered).toHaveBeenCalledOnce();
  });

  it("a stop before the look reminds nobody; a reminder cut by the stop is not reported", async () => {
    const stop = new AbortController();
    const { instance, remind, warn } = look([due("acme", "root-1", "p-1", 1)], {
      signal: stop.signal,
    });
    remind.mockImplementationOnce(() => {
      stop.abort();
      return Promise.reject(new Error("interrupted"));
    });
    await instance.run();
    await instance.settled();
    remind.mockClear();

    await instance.run();

    expect(warn).not.toHaveBeenCalled();
    expect(remind).not.toHaveBeenCalled();
  });
});
