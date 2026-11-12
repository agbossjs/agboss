/**
 * #923 (acceptance) — `app.close({ timeout })` ends within its timeout whatever a store does: an
 * execution that waits for a lease take nobody answers (deaf to the interruption, as a Redis call
 * on a quiet server is), and an `onDestroy` — a connection's close — that never returns. What
 * still hangs is given up and logged as `app.stop-store-call-pending`, naming it.
 */
import { beforeEach, describe, expect, vi } from "vitest";
import { TestConcurrency, testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { passLive } from "../helpers/live-time.js";
import { logged, resetLogged } from "../helpers/log.js";
import { ClaimRoomItemWorkflowStart, roomLog } from "./fixtures/claim-room.workflow.js";
import { hung, HungStoreApplication, resetHung } from "./fixtures/hung-store.application.js";

const test = testWith(HungStoreApplication, { concurrency: TestConcurrency.Real });

beforeEach(() => {
  resetHung();
  resetLogged();
});

const pendingLogs = (): string[] =>
  logged.filter((entry) => entry.code === "app.stop-store-call-pending").map((e) => e.message);

describe("#923: close() within its timeout when the store goes quiet", () => {
  test("a running execution blocked in a lease release nobody answers", async ({ app, clock }) => {
    await app.ready();
    const running = execute(app, ClaimRoomItemWorkflowStart, {
      name: "root",
      delay: 0,
      outcome: "ok",
    });
    running.catch((): undefined => undefined);
    await vi.waitFor(() => {
      expect(roomLog.gates.has("root")).toBe(true);
    });
    hung.lease = true;

    const closed = app.close();
    await passLive(clock, seconds(60));
    await closed;

    expect(pendingLogs().join("\n")).toContain("the running executions");
  });

  test("an onDestroy that is never answered", async ({ app, clock }) => {
    await app.ready();
    hung.destroy = true;

    const closed = app.close();
    await passLive(clock, seconds(60));
    await closed;

    expect(pendingLogs().join("\n")).toContain("onDestroy of HungConnection");
  });
});
