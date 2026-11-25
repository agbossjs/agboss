/**
 * #1131 (the acceptance of #940 AC3 / I9): a receiver that runs past the 60 s claim of its mailbox
 * is never called again beside itself — by the same instance or another: the claim is renewed while
 * the receiver runs, so one mailbox is delivered by one caller at a time, notice after notice, in
 * the order written. At least once stays the guarantee (a receiver that died is told again once its
 * claim lapses); only the concurrent double delivery of one notice goes. The refund tool's channel
 * runs under the tool's `timeout` of 5 minutes, so its hook may take longer than a claim.
 */
import { beforeEach, describe, expect, vi } from "vitest";
import { callTool, testWith } from "../../src/testing/index.js";
import { seconds, type Milliseconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { askFor, until } from "../channels/fixtures/pause-scripts.js";
import {
  DeskClerkAgent,
  DeskWorkflowStart,
  hooks,
  pauseStore,
  PausesApplication,
  resetPauses,
  seen,
  SlowRefundTool,
} from "../channels/fixtures/pauses.workflow.js";
import { PauseResolution } from "../../src/index.js";
import { logged, resetLogged } from "../helpers/log.js";

const one = testWith(PausesApplication);
const two = testWith(PausesApplication, { instances: 2 });
const ACME = { tenant: { tenantId: "acme" }, threadId: "refund-thread" };
const REFUND = { text: "refund order 7" };

beforeEach(() => {
  resetPauses();
  resetLogged();
});

/** How many hook calls run at once, and how many were made. */
const concurrency = { active: 0, widest: 0 };
beforeEach(() => {
  concurrency.active = 0;
  concurrency.widest = 0;
});

/** A hook that stays running until `release()`, counting the calls running at once. */
function heldHook(): { readonly hook: () => Promise<void>; readonly release: () => void } {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release: () => {
      release();
    },
    hook: async () => {
      concurrency.active += 1;
      concurrency.widest = Math.max(concurrency.widest, concurrency.active);
      try {
        await held;
      } finally {
        concurrency.active -= 1;
      }
    },
  };
}

/** A hook that runs `length` on the application's clock, counting the calls running at once. */
function timedHook(
  sleep: (ms: Milliseconds) => Promise<void>,
  length: Milliseconds,
): () => Promise<void> {
  return async () => {
    concurrency.active += 1;
    concurrency.widest = Math.max(concurrency.widest, concurrency.active);
    try {
      await sleep(length);
    } finally {
      concurrency.active -= 1;
    }
  };
}

describe("#1131 AC3: a receiver past the claim is never called twice at once", () => {
  one(
    "AC3: a 70 s receiver on one instance is called once, never beside itself",
    async ({ app, clock, mockLlm }) => {
      const held = heldHook();
      hooks.closeWait = held.hook;
      mockLlm(DeskClerkAgent).thenReturn(callTool(SlowRefundTool, { orderId: "7" }));
      const paused = await execute(app, DeskWorkflowStart, REFUND, ACME);

      await app.cancel(paused.threadId, { tenantId: "acme" });
      await until(() => seen.closed.length === 1);
      for (let tick = 0; tick < 14; tick += 1) await clock.advance(seconds(5));

      expect(seen.closed).toHaveLength(1);
      expect(concurrency.widest).toBe(1);
      held.release();
      await until(() => concurrency.active === 0);
      // acknowledged after it returned: never told again
      for (let tick = 0; tick < 14; tick += 1) await clock.advance(seconds(5));
      expect(seen.closed).toHaveLength(1);
      expect(await pauseStore().countNotices()).toMatchObject({ dead: 0 });
    },
  );

  two(
    "AC3: a 70 s receiver with two instances looking is called once, never beside itself",
    async ({ apps, clock, mockLlm }) => {
      const held = heldHook();
      hooks.closeWait = held.hook;
      mockLlm(DeskClerkAgent).thenReturn(callTool(SlowRefundTool, { orderId: "7" }));
      const [first, second] = apps;
      if (first === undefined || second === undefined) throw new Error("two instances expected");
      for (const app of apps) await app.ready();
      const paused = await execute(first, DeskWorkflowStart, REFUND, ACME);

      await second.cancel(paused.threadId, { tenantId: "acme" });
      await until(() => seen.closed.length === 1);
      for (let tick = 0; tick < 14; tick += 1) await clock.advance(seconds(5));

      expect(seen.closed).toHaveLength(1);
      expect(concurrency.widest).toBe(1);
      held.release();
      await until(() => concurrency.active === 0);
      for (let tick = 0; tick < 14; tick += 1) await clock.advance(seconds(5));
      expect(seen.closed).toHaveLength(1);
    },
  );

  two(
    "AC3: a chain of notices longer than the claim: each is told once, the next only after the one before returned, in order",
    async ({ apps, clock, mockLlm }) => {
      // closed (answered) then answerNotTaken (cancelled): 40 s + 40 s on one claim of 60 s
      hooks.closeWait = timedHook((ms) => clock.sleep(ms), seconds(40));
      hooks.notTakenWait = timedHook((ms) => clock.sleep(ms), seconds(40));
      mockLlm(DeskClerkAgent).thenReturn(callTool(SlowRefundTool, { orderId: "7" }));
      const [first, second] = apps;
      if (first === undefined || second === undefined) throw new Error("two instances expected");
      for (const app of apps) await app.ready();
      await execute(first, DeskWorkflowStart, REFUND, ACME);
      const pauseId = askFor("7").pauseId;
      const recipients = { channel: "finance-desk-refund-approval-channel", listeners: [] };
      const answer = { decision: { approved: true }, actor: { id: "manager-17" } };
      await pauseStore().resolveByTenantIdAndPauseId(
        "acme",
        pauseId,
        answer,
        clock.now(),
        recipients,
      );
      await pauseStore().closeUntakenByTenantIdAndPauseId(
        "acme",
        pauseId,
        PauseResolution.Cancelled,
        clock.now(),
        recipients,
      );

      for (let tick = 0; tick < 24; tick += 1) await clock.advance(seconds(5));

      expect(seen.closed).toHaveLength(1);
      expect(seen.notTaken).toHaveLength(1);
      expect(concurrency.widest).toBe(1);
      expect(logged.filter((entry) => entry.code === "pause.notice-failed")).toEqual([]);
    },
  );

  one(
    "AC3 sabotage: without the renewal the same receiver is called twice at once",
    async ({ app, clock, mockLlm }) => {
      await app.ready();
      vi.spyOn(pauseStore(), "renewNotice").mockImplementation((claim) => Promise.resolve(claim));
      const held = heldHook();
      hooks.closeWait = held.hook;
      mockLlm(DeskClerkAgent).thenReturn(callTool(SlowRefundTool, { orderId: "7" }));
      const paused = await execute(app, DeskWorkflowStart, REFUND, ACME);

      await app.cancel(paused.threadId, { tenantId: "acme" });
      await until(() => seen.closed.length === 1);
      for (let tick = 0; tick < 14; tick += 1) await clock.advance(seconds(5));

      await until(() => seen.closed.length === 2);
      expect(concurrency.widest).toBe(2);
      held.release();
    },
  );
});
