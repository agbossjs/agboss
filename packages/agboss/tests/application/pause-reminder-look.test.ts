/**
 * #942: the reminder look of the pause timers on its own — a page of due reminders read at the
 * clock's now, each written once with the pause's recipients; a pause of a tree whose root has no
 * record of this instance's workflows (another application on a shared store) is left alone, one
 * that fails is told and the others go on, a stop ends the look between two pauses, and the notices
 * written are looked for at once.
 */
import { describe, expect, it, vi } from "vitest";
import { REMINDER_PAGE, lookForReminders } from "../../src/application/pause-reminder-look.js";

const due = (tenantId: string, rootExecutionId: string, pauseId: string) =>
  ({ tenantId, rootExecutionId, pauseId }) as never;

function look(pauses: readonly unknown[], extra: { signal?: AbortSignal } = {}) {
  const find = vi.fn(() => Promise.resolve(pauses));
  const remind = vi.fn(() => Promise.resolve(true));
  const warn = vi.fn();
  const delivered = vi.fn();
  const recipientsOf = vi.fn(() => ({ channel: "manager-channel", listeners: ["audit"] }));
  const records = {
    findByTenantIdAndRunId: vi.fn((tenantId: string, runId: string) =>
      Promise.resolve(
        runId === "orphan"
          ? undefined
          : { tenantId, runId, bundle: runId === "foreign" ? "other-workflow" : "desk-workflow" },
      ),
    ),
  };
  const sources = {
    pauses: { findPendingByRemindAtBefore: find, remindByTenantIdAndPauseId: remind },
    records,
    bundles: new Set(["desk-workflow"]),
    recipientsOf,
    delivered,
    clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
    log: { warn },
    signal: extra.signal ?? new AbortController().signal,
  };
  return { sources: sources as never, find, remind, warn, delivered, recipientsOf };
}

describe("#942: the reminder look", () => {
  it("reads a page of due reminders at the clock's now", async () => {
    const { sources, find } = look([]);

    await lookForReminders(sources);

    expect(find).toHaveBeenCalledWith(new Date("2026-01-01T00:00:00.000Z"), REMINDER_PAGE);
    expect(REMINDER_PAGE).toBe(50);
  });

  it("reminds each due pause once, at the look's now, with its recipients, then looks for the notices", async () => {
    const { sources, remind, recipientsOf, delivered } = look([
      due("acme", "root-1", "p-1"),
      due("globex", "root-2", "p-2"),
    ]);

    await lookForReminders(sources);

    const at = new Date("2026-01-01T00:00:00.000Z");
    const recipients = { channel: "manager-channel", listeners: ["audit"] };
    expect(remind.mock.calls).toEqual([
      ["acme", "p-1", at, recipients],
      ["globex", "p-2", at, recipients],
    ]);
    expect(recipientsOf).toHaveBeenCalledTimes(2);
    expect(delivered).toHaveBeenCalledOnce();
  });

  it("a pause another instance reminded first (the store says no) writes nothing and looks for nothing", async () => {
    const { sources, remind, delivered } = look([due("acme", "root-1", "p-1")]);
    remind.mockResolvedValueOnce(false);

    await lookForReminders(sources);

    expect(delivered).not.toHaveBeenCalled();
  });

  it("a tree with no record, or one of another application's workflow, is left alone", async () => {
    const { sources, remind } = look([due("acme", "orphan", "p-1"), due("acme", "foreign", "p-2")]);

    await lookForReminders(sources);

    expect(remind).not.toHaveBeenCalled();
  });

  it("a pause that fails is told (pause.reminder-failed, its ids) and the next goes on", async () => {
    const { sources, remind, warn, delivered } = look([
      due("acme", "root-1", "p-1"),
      due("acme", "root-2", "p-2"),
    ]);
    remind.mockRejectedValueOnce(new Error("the store is down"));

    await lookForReminders(sources);

    expect(remind).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith("pause.reminder-failed", expect.stringContaining("root-1"), {
      tenantId: "acme",
      executionId: "root-1",
    });
    expect(delivered).toHaveBeenCalledOnce();
  });

  it("a stop ends the look between two pauses; one cut by the stop is not reported", async () => {
    const stop = new AbortController();
    const { sources, remind, warn } = look(
      [due("acme", "root-1", "p-1"), due("acme", "root-2", "p-2")],
      { signal: stop.signal },
    );
    remind.mockImplementationOnce(() => {
      stop.abort();
      return Promise.reject(new Error("interrupted"));
    });

    await lookForReminders(sources);

    expect(remind).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });
});
