/**
 * #859 AC2: a task's files outlive every pause — a paused (`INPUT_REQUIRED`) task keeps them however
 * long it waits — and go `retention.a2aFiles` after the task is over; a file whose task never came
 * to be goes once it is that old (and two leases old at least).
 */
import { describe, expect, it } from "vitest";
import {
  a2aFileExpiryOf,
  type NewA2AFile,
} from "../../../src/infrastructure/a2a-file.repository.js";
import {
  A2ATaskState,
  type A2ATaskStatus,
} from "../../../src/infrastructure/a2a-task.repository.js";
import { InMemoryA2AFileRepository } from "../../../src/infrastructure/in-memory-a2a-file.repository.js";
import { InMemoryA2ATaskRepository } from "../../../src/infrastructure/in-memory-a2a-task.repository.js";
import { InMemoryDatabase } from "../../../src/infrastructure/in-memory-database.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { hours, minutes, seconds } from "../../../src/units/index.js";

const START = new Date("2026-01-05T09:00:00.000Z");

function storesAt() {
  const database = new InMemoryDatabase();
  const clock = new VirtualClock(START);
  const files = new InMemoryA2AFileRepository(database);
  const tasks = new InMemoryA2ATaskRepository(database);
  const expiry = a2aFileExpiryOf({ files, tasks, clock, retention: hours(24), pageSize: 2 });
  /** One sweep look now: its cutoff `retention` before the clock. */
  const sweep = () => expiry.remove?.(new Date(clock.now().getTime() - hours(24)));
  const fileOf = (ownerId: string): NewA2AFile => ({
    tenantId: "default",
    fileId: `${ownerId}.0`,
    ownerId,
    mediaType: "application/pdf",
    sha256: "a".repeat(64),
    sizeBytes: 3,
    createdAt: clock.now(),
    bytes: Uint8Array.from([1, 2, 3]),
  });
  const taskIn = async (taskId: string, state: A2ATaskState) => {
    await tasks.saveIfAbsent({
      tenantId: "default",
      ownerId: "dana",
      messageId: `m-${taskId}`,
      taskId,
      contextId: `c-${taskId}`,
      skill: "file-review-workflow-start",
      status: { state: A2ATaskState.Submitted, pendingPauses: [] },
      acceptedAt: clock.now(),
      requestHash: "h",
    });
    const status: A2ATaskStatus = { state, pendingPauses: [] };
    await tasks.compareAndSetStatus({ tenantId: "default", taskId }, 1, status, clock.now());
  };
  const has = async (ownerId: string) =>
    (await files.findMetadata({ tenantId: "default", fileId: `${ownerId}.0` })) !== undefined;
  return { clock, files, taskIn, sweep, fileOf, has };
}

describe("#859 AC2: the files of a task go retention.a2aFiles after it is over, never before", () => {
  it("a paused task's file stays past any retention; once the task completes, retention later it goes", async () => {
    const stores = storesAt();
    await stores.files.save(stores.fileOf("paused"));
    await stores.taskIn("paused", A2ATaskState.InputRequired);

    await stores.clock.advance(hours(72));
    await stores.sweep();
    const keptWhilePaused = await stores.has("paused");
    await stores.taskIn("done-now", A2ATaskState.Completed);
    await stores.files.save(stores.fileOf("done-now"));
    await stores.clock.advance(hours(23));
    await stores.sweep();
    const keptWithinRetention = await stores.has("done-now");
    await stores.clock.advance(hours(2));
    await stores.sweep();

    expect(keptWhilePaused).toBe(true);
    expect(keptWithinRetention).toBe(true);
    expect(await stores.has("done-now")).toBe(false);
    expect(await stores.has("paused")).toBe(true);
  });

  it("every terminal state lets its files go; a working task keeps them", async () => {
    const stores = storesAt();
    const states = [
      A2ATaskState.Completed,
      A2ATaskState.Failed,
      A2ATaskState.Canceled,
      A2ATaskState.Rejected,
      A2ATaskState.Working,
    ];
    for (const state of states) {
      await stores.files.save(stores.fileOf(state));
      await stores.taskIn(state, state);
    }

    await stores.clock.advance(hours(25));
    await stores.sweep();

    const kept = await Promise.all(states.map((state) => stores.has(state)));
    expect(kept).toEqual([false, false, false, false, true]);
  });

  it("owners still kept never hide one after them: the expired one goes in the same look", async () => {
    const stores = storesAt();
    for (const live of ["a-live", "b-live", "c-live"]) {
      await stores.files.save(stores.fileOf(live));
      await stores.taskIn(live, A2ATaskState.InputRequired);
    }
    await stores.files.save(stores.fileOf("d-done"));
    await stores.taskIn("d-done", A2ATaskState.Completed);

    await stores.clock.advance(hours(25));
    await stores.sweep();

    expect(await stores.has("d-done")).toBe(false);
    expect(
      await Promise.all(["a-live", "b-live", "c-live"].map((live) => stores.has(live))),
    ).toEqual([true, true, true]);
  });

  it("a file whose task never came to be goes past the cutoff, and only two leases after its save", async () => {
    const stores = storesAt();
    await stores.files.save(stores.fileOf("orphan"));

    await stores.clock.advance(hours(24));
    await stores.clock.advance(seconds(1));
    await stores.files.save(stores.fileOf("fresh"));
    await stores.sweep();
    const fresh = await stores.has("fresh");
    await stores.clock.advance(minutes(1));

    expect(await stores.has("orphan")).toBe(false);
    expect(fresh).toBe(true);
  });
});
