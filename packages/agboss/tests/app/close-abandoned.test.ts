/**
 * #954 AC3 / AC4 — what `app.close({ timeout })` leaves behind when it gives a hung run up: the
 * caller's `execute()` settles with a typed framework error (never stays pending), and no
 * `app.step-still-running` warning is logged after `close()` resolved.
 */
import { beforeEach, describe, expect, vi } from "vitest";
import { ApplicationStoppingError } from "../../src/errors.js";
import { TestConcurrency, testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { passLive } from "../helpers/live-time.js";
import { logged, resetLogged } from "../helpers/log.js";
import {
  ClaimRoomItemWorkflowStart,
  resetRoomLog,
  roomLog,
} from "./fixtures/claim-room.workflow.js";
import {
  answerHung,
  hung,
  HungStoreApplication,
  resetHung,
} from "./fixtures/hung-store.application.js";

const test = testWith(HungStoreApplication, { concurrency: TestConcurrency.Real });

beforeEach(() => {
  resetHung();
  resetLogged();
  resetRoomLog();
});

const stillRunning = (): number =>
  logged.filter((entry) => entry.code === "app.step-still-running").length;

const startRoot = async (app: Parameters<typeof execute>[0]) => {
  const running = execute(app, ClaimRoomItemWorkflowStart, {
    name: "root",
    delay: 0,
    outcome: "ok",
  });
  const outcome = running.then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.waitFor(() => {
    expect(roomLog.gates.has("root")).toBe(true);
  });
  return { outcome };
};

describe("#954 AC3: an abandoned execute() settles with a typed error", () => {
  test("AC3: execute() blocked in a lease release nobody answers rejects ApplicationStoppingError", async ({
    app,
    clock,
  }) => {
    await app.ready();
    const { outcome } = await startRoot(app);
    hung.lease = true;

    const closed = app.close();
    await passLive(clock, seconds(6));
    await closed;

    const error = await Promise.race([
      outcome,
      new Promise((done) => setTimeout(done, 500, "pending")),
    ]);
    expect(error).toBeInstanceOf(ApplicationStoppingError);
    expect(error).toMatchObject({ code: "app.stopping" });
  });
});

describe("#954 AC4: no shutdown warning after close() resolved", () => {
  test("AC4: a body still running at the end is logged before close() returns, never after", async ({
    app,
    clock,
  }) => {
    await app.ready();
    roomLog.deaf = true;
    await startRoot(app);
    hung.lease = true;

    const closed = app.close();
    await passLive(clock, seconds(6));
    await closed;
    const atClose = stillRunning();

    answerHung();
    for (const open of roomLog.gates.values()) open();
    await new Promise((done) => setTimeout(done, 300));

    expect(atClose).toBe(1);
    expect(stillRunning()).toBe(atClose);
  });
});
