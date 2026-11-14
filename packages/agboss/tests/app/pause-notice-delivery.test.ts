/**
 * #940 AC4: a notice a receiver fails is retried after growing pauses (1 s × 2^attempts, at most
 * 5 min), logged each time (`pause.notice-failed`, a fixed problem code, never a message), and
 * after `retention.pauseRecords` set aside (`pause.notice-dead`, counted) — the other pauses' and
 * receivers' notices keep flowing; a hanging receiver is cut off at its timeout; a receiver no
 * instance knows is set aside by the recovery sweep, its pause removed with its retention; the
 * run, the resume and the cancel never wait for a receiver.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { backoffAfter } from "../../src/app/pause-notice-delivery.js";
import { PauseResolution } from "../../src/index.js";
import { callTool, testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { logged, resetLogged } from "../helpers/log.js";
import { until } from "../channels/fixtures/pause-scripts.js";
import {
  DeskClerkAgent,
  DeskWorkflowStart,
  hooks,
  pauseStore,
  RetainedPausesApplication,
  RefundTool,
  resetPauses,
  seen,
} from "../channels/fixtures/pauses.workflow.js";
import { pauseOf } from "../../src/testing/contracts/paused-execution-data.js";

const retained = testWith(RetainedPausesApplication);
const ACME = { tenant: { tenantId: "acme" }, threadId: "refund-thread" };
const REFUND = { text: "refund order 7" };

beforeEach(() => {
  resetPauses();
  resetLogged();
});

const logs = (code: string) => logged.filter((entry) => entry.code === code);

describe("#940 AC4: backoff, set aside after the retention, others flow", () => {
  it("AC4: attempts are retried at +1, +2, +4 … seconds, capped at 5 minutes", () => {
    expect([0, 1, 2, 3, 4, 8, 9, 20].map(backoffAfter)).toEqual([
      1000, 2000, 4000, 8000, 16_000, 256_000, 300_000, 300_000,
    ]);
  });

  retained(
    "AC4: a receiver that fails 3 times then succeeds: warnings at growing intervals, then one delivery",
    async ({ app, clock, mockLlm }) => {
      const at: number[] = [];
      hooks.closeWait = () => {
        at.push(clock.now().getTime());
        return Promise.resolve();
      };
      hooks.listenerFailures = 0;
      hooks.closeFailure = new Error("slack is down");
      mockLlm(DeskClerkAgent).thenReturn(callTool(RefundTool, { orderId: "7" }));
      const paused = await execute(app, DeskWorkflowStart, REFUND, ACME);

      await app.cancel(paused.threadId, { tenantId: "acme" });
      await until(() => at.length === 1);
      await clock.advance(seconds(5));
      await until(() => at.length === 2);
      await clock.advance(seconds(5));
      await until(() => at.length === 3);
      delete hooks.closeFailure;
      await clock.advance(seconds(10));
      await until(() => at.length === 4);

      // the first attempt at once, the others at the timers' ticks once due (1 s, +2 s, +4 s)
      const start = at[0] ?? 0;
      expect(at.map((time) => (time - start) / 1000)).toEqual([0, 5, 10, 20]);
      expect(logs("pause.notice-failed")).toHaveLength(3);
      expect(logs("pause.notice-failed")[0]?.message).toContain("receiver-failed");
      expect(logs("pause.notice-failed")[0]?.message).not.toContain("slack is down");
      expect(await pauseStore().countNotices()).toEqual({ live: 0, dead: 0 });
    },
  );

  retained(
    "AC4: set aside after the retention: logged pause.notice-dead, countNotices dead 1, other receivers flow",
    async ({ app, clock, mockLlm }) => {
      hooks.closeFailure = new Error("slack is down");
      await app.ready();
      const setAside = vi.spyOn(pauseStore(), "setAsideNotices");
      mockLlm(DeskClerkAgent).thenReturn(callTool(RefundTool, { orderId: "7" }));
      const paused = await execute(app, DeskWorkflowStart, REFUND, ACME);
      await app.cancel(paused.threadId, { tenantId: "acme" });
      await until(() => seen.closed.length === 1);

      // the attempts come at 0, 5, 10, 15, 25, 45, 80 s and then at 145 s: past the retention
      // (the sweep removes the closed pause at 150 s, a dead mailbox with it)
      await clock.advance(seconds(146));

      await until(() => logs("pause.notice-dead").length === 1);
      // the set-aside mailbox stays out of the live count; its pause goes with the retention
      expect(await pauseStore().countNotices()).toMatchObject({ live: 0 });
      expect(setAside).toHaveBeenCalledTimes(1);
      expect(logs("pause.notice-dead")).toMatchObject([
        { level: "error", message: expect.stringContaining("channel:refund-approval-channel") },
      ]);
      // the listener of the same pause heard opened and closed meanwhile
      expect(seen.heard.filter((one) => one.listener === "audit").map((one) => one.type)).toEqual([
        "opened",
        "closed",
      ]);
    },
  );

  retained(
    "AC4: a hanging receiver is cut off at its tool's timeout and retried",
    async ({ app, clock, mockLlm }) => {
      hooks.closeWait = () => new Promise<void>(() => undefined);
      mockLlm(DeskClerkAgent).thenReturn(callTool(RefundTool, { orderId: "7" }));
      const paused = await execute(app, DeskWorkflowStart, REFUND, ACME);
      await app.cancel(paused.threadId, { tenantId: "acme" });
      await until(() => seen.closed.length === 1);

      await clock.advance(seconds(30));

      await until(() => logs("pause.notice-failed").length === 1);
      expect(logs("pause.notice-failed")[0]?.message).toContain("receiver-timeout");
    },
  );

  retained(
    "AC4: the cancel never waits for a receiver: it returns while the hook hangs",
    async ({ app, clock, mockLlm }) => {
      hooks.closeWait = () => new Promise<void>(() => undefined);
      mockLlm(DeskClerkAgent).thenReturn(callTool(RefundTool, { orderId: "7" }));
      const paused = await execute(app, DeskWorkflowStart, REFUND, ACME);

      await app.cancel(paused.threadId, { tenantId: "acme" });

      await until(() => seen.closed.length === 1);
      expect(logs("pause.notice-failed")).toEqual([]);
      // the hook is cut off at its timeout, so the test's instance can close
      await clock.advance(seconds(30));
    },
  );

  retained(
    "AC4: a listener removed by a deploy: its mailboxes set aside after the retention, logged recipient-unknown, the pause removed",
    async ({ app, clock }) => {
      await app.ready();
      const store = pauseStore();
      const ghost = { listeners: ["ghost-pause-listener"] };
      await store.findOrCreateByStepKey(pauseOf("ghost-pause", "run-g:clerk-agent:1:call-1"));
      await store.markSentByTenantIdAndPauseId("default", "ghost-pause", ghost);
      await store.cancelByTenantIdAndPauseId(
        "default",
        "ghost-pause",
        PauseResolution.Cancelled,
        clock.now(),
        ghost,
      );
      expect(await store.countNotices()).toEqual({ live: 1, dead: 0 });

      await clock.advance(seconds(200));

      // set aside once the head is older than the retention, then the pause goes with it
      await until(() => logs("pause.notice-recipient-unknown").length === 1);
      await until(
        async () => (await store.findByTenantIdAndPauseId("default", "ghost-pause")) === undefined,
      );
      expect(await store.countNotices()).toEqual({ live: 0, dead: 0 });
    },
  );
});
