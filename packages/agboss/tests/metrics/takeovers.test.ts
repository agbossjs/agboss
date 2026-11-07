/**
 * #485 AC3 — a lease takeover counts on the instance that took the tree over, with its reason
 * (`agboss.instance.lease.takeovers`; a recovery is `reason="recovered"`), never on the holder it
 * was taken from; the frozen holder's refused step is its hand-over.
 */
import { afterEach, beforeEach, describe, expect } from "vitest";
import { HandOverReason, LeaseTakeoverReason } from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { resetRecovery } from "../infrastructure/fixtures/recovery.workflow.js";
import { instance, rejectionOf, settle, takenOver } from "../app/fixtures/fence-takeover.js";
import { resetScopes } from "../app/fixtures/fence-children.workflow.js";
import { levers, resetFence } from "../app/fixtures/fence.workflow.js";
import {
  LeaseEventsApplication,
  resetLeaseEvents,
} from "../app/fixtures/lease-events.application.js";
import { collect, instanceMeters, valueOf } from "./support/metric-reader.js";

const TAKEOVERS = "agboss.instance.lease.takeovers";
const HANDED_OVER = "agboss.instance.steps.handed_over";

const meters = instanceMeters(2);
const two = testWith(LeaseEventsApplication, {
  instances: meters.map((meter) => ({ meterProvider: meter.provider })),
});

beforeEach(() => {
  resetFence();
  resetRecovery();
  resetScopes();
  resetLeaseEvents();
});
afterEach(() => {
  levers.letGo?.();
});

describe("#485 AC3: takeovers count where they happen", () => {
  two(
    "AC3: a takeover counts on the instance that took over, with its reason, never on the old holder",
    async ({ apps, clock, leases }) => {
      const [zombie, taker] = meters;
      if (zombie === undefined || taker === undefined) throw new Error("two meters");

      const { call } = await takenOver(apps, clock, leases);

      const recovered = { reason: LeaseTakeoverReason.Recovered };
      expect(valueOf(await collect(taker), TAKEOVERS, recovered)).toBe(1);
      expect((await collect(zombie)).get(TAKEOVERS)).toBeUndefined();
      // the zombie, let go, is refused at its write: a hand-over on its own instance only
      leases.thaw(instance(apps, 0));
      levers.letGo?.();
      await settle();
      await rejectionOf(call);
      const fromZombie = await collect(zombie);
      const lost = [HandOverReason.LeaseLost, HandOverReason.Fenced].map((reason) =>
        valueOf(fromZombie, HANDED_OVER, { reason }),
      );
      expect(lost.some((count) => count === 1)).toBe(true);
      expect((await collect(taker)).get(HANDED_OVER)).toBeUndefined();
      expect((await collect(zombie)).get(TAKEOVERS)).toBeUndefined();
    },
  );
});
