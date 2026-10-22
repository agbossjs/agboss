/**
 * #340 PR 4 (AC4, M4 automated) — the automatic undo on SQLite across two instances (two
 * connections to one file): an instance that stops mid-undo leaves its `running` root and the
 * tree's `@agboss/` keys on the file; the other instance's sweep finishes the undo — the undo done
 * not run again — and ends the tree as cancelled, its keys removed.
 */
import { beforeEach, describe, expect, vi } from "vitest";
import { ApplicationStoppingError } from "../../../src/index.js";
import { ExecutionCancelledError } from "../../../src/core/errors.js";
import { testWith } from "../../../src/testing/index.js";
import { seconds } from "../../../src/units/index.js";
import { execute } from "../../helpers/flow.js";
import { resetRecovery } from "../fixtures/recovery.workflow.js";
import { UndoDesk } from "../../flow/runtime/fixtures/undo.workflow.js";
import {
  UnwindGate,
  unwindSeen,
  UnwindWorkflowStart,
} from "../../flow/runtime/fixtures/unwind.workflow.js";
import { SqliteUnwindApplication, sqliteFilePerTest } from "./fixtures/sqlite.workflow.js";

sqliteFilePerTest();
const test = testWith(SqliteUnwindApplication, { instances: 2 });

beforeEach(() => {
  resetRecovery();
  unwindSeen.undos.length = 0;
  unwindSeen.errors.length = 0;
});

/** Waits for `signal` to abort, then rejects with its reason. */
const untilAborted = (signal: AbortSignal): Promise<void> =>
  new Promise<void>((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      reject(signal.reason as Error);
    });
  });

describe("#340 AC4 on SQLite: an undo interrupted by a stop", () => {
  test("is finished by the other instance; the undo done is not run again", async ({
    apps,
    clock,
    mockOf,
  }) => {
    const desk = mockOf(UndoDesk);
    let isSeatHeld = true;
    desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
    desk.release.mockImplementation((id: string, _key: string, signal: AbortSignal) => {
      if (id !== "seat-1" || !isSeatHeld) return Promise.resolve();
      isSeatHeld = false;
      return untilAborted(signal);
    });
    mockOf(UnwindGate).wait.mockImplementation((_guest: string, signal: AbortSignal) =>
      untilAborted(signal),
    );
    const [first, second] = apps;
    if (first === undefined || second === undefined) throw new Error("two instances");
    await first.ready();
    await second.ready();
    const run = execute(first, UnwindWorkflowStart, { guest: "ada" }, { threadId: "t-1" });
    run.catch(() => undefined);
    await vi.waitFor(() => {
      expect(mockOf(UnwindGate).wait.mock.calls).toHaveLength(1);
    });

    await first.cancel("t-1");
    await vi.waitFor(() => {
      expect(desk.release.mock.calls).toHaveLength(2);
    });
    const closed = first.close({ timeout: seconds(5) });
    await clock.advance(seconds(5));
    await closed;
    await expect(run).rejects.toBeInstanceOf(ApplicationStoppingError);
    await clock.advance(seconds(30));
    await vi.waitFor(() => {
      expect(unwindSeen.errors).toHaveLength(1);
    });

    expect(desk.release.mock.calls.map(([id]) => id)).toEqual(["room-1", "seat-1", "seat-1"]);
    expect(unwindSeen.errors[0]?.error).toBeInstanceOf(ExecutionCancelledError);
  });
});
