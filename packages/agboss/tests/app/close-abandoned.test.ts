/**
 * #954 AC3 / AC4 — what `app.close({ timeout })` leaves behind when it gives a hung run up: the
 * caller's `execute()` settles with a typed framework error (never stays pending), and no
 * `app.step-still-running` warning is logged after `close()` resolved.
 */
import { beforeEach, describe, expect, vi } from "vitest";
import { ApplicationStoppingError } from "../../src/errors.js";
import { callTool, replyWith, TestConcurrency, testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { answerOf, execute } from "../helpers/flow.js";
import { passLive } from "../helpers/live-time.js";
import { logged, resetLogged } from "../helpers/log.js";
import {
  ClaimRoomItemWorkflowStart,
  resetRoomLog,
  roomLog,
} from "./fixtures/claim-room.workflow.js";
import { Charge, Clerk, Probe, ReceiptDto, Start } from "./fixtures/run-context.workflow.js";
import {
  answerHung,
  hung,
  HungCheckoutApplication,
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

describe("#954 AC3: no execute() or resume() outlives close()", () => {
  test("AC3: execute() blocked in a hung store call longer than the shutdown timeout has settled by the time close() resolves", async ({
    app,
    clock,
  }) => {
    await app.ready();
    let settled = false;
    execute(app, ClaimRoomItemWorkflowStart, { name: "root", delay: 0, outcome: "ok" }).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => {
      expect(roomLog.gates.has("root")).toBe(true);
    });
    hung.lease = true; // the store's own bound (15 s) is longer than the 5 s shutdown timeout

    const closed = app.close();
    await passLive(clock, seconds(6));
    await closed;

    expect(settled).toBe(true);
  });
});

describe("#954 AC3: an abandoned resume() settles with a typed error", () => {
  const resumeTest = testWith(HungCheckoutApplication, { concurrency: TestConcurrency.Real });

  resumeTest(
    "AC3: resume() blocked in a lease release nobody answers rejects ApplicationStoppingError",
    async ({ app, clock, mockLlm }) => {
      mockLlm(Clerk).thenReturn(
        callTool(Probe, { text: "card" }),
        callTool(Charge, { text: "10 USD" }),
        replyWith(ReceiptDto, { text: "Charged." }),
      );
      await app.ready();
      const paused = await execute(app, Start, { text: "charge" });
      hung.lease = true;

      let settled = false;
      const resumed = app.resume(answerOf(paused, { approved: true })).then(
        () => {
          settled = true;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      await vi.waitFor(() => {
        expect(hung.calls).toBeGreaterThan(0);
      });
      const closed = app.close();
      await passLive(clock, seconds(6));
      await closed;

      // settled by the time close() resolved, not later (the store's bound, 15 s, is longer than the 5 s timeout)
      expect(settled).toBe(true);
      const error = await Promise.race([
        resumed,
        new Promise((done) => setTimeout(done, 500, "pending")),
      ]);
      expect(error).toBeInstanceOf(ApplicationStoppingError);
      expect(error).toMatchObject({ code: "app.stopping" });
    },
  );
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
