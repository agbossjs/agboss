import { expect } from "vitest";
import type { PauseScanAfter } from "../../infrastructure/pause-notices.js";
import { seenOf } from "../../infrastructure/pause-seen.js";
import { NINE, RECIPIENTS } from "./paused-execution-data.js";
import {
  deadline,
  off,
  preciseOf,
  reminder,
  sameAs,
  stored,
  type Case,
  type Instances,
} from "./paused-execution-instants-data.js";

/**
 * #1307 (G3): the scans' `after` keyset reads the instants to the millisecond on every scan — the
 * reminder scan and the unsent-reassigned scan as well as the deadline scan — and orders two pauses
 * of one instant by `(tenantId, pauseId)`. A store that binds `after.at` as another spelling of a
 * time, or keeps one scan's time as text, fails one of them.
 */
const idsOf = (pauses: readonly { readonly pauseId: string }[]): string[] =>
  pauses.map((pause) => pause.pauseId);

const KEY = { tenantId: "default" };

export const INSTANT_KEYSET_CASES: readonly Case[] = [
  {
    name: "#1307: the reminder scan's keyset is read to the millisecond: after a time 1 ms earlier the pause is listed, after its own instant it is not",
    run: async ({ first: one, second }: Instances): Promise<void> => {
      await one.findOrCreateByStepKey(preciseOf("pause-a"));
      const remind = (after: PauseScanAfter) =>
        second.findPendingByRemindAtBefore(off(reminder(), 1000), 10, after).then(idsOf);

      expect(await remind({ ...KEY, pauseId: "pause-a", at: off(reminder(), -1) })).toEqual([
        "pause-a",
      ]);
      expect(await remind({ ...KEY, pauseId: "pause-a", at: sameAs(reminder()) })).toEqual([]);
      expect(await remind({ ...KEY, pauseId: "pause-a", at: off(reminder(), 1) })).toEqual([]);
    },
  },
  {
    name: "#1307: the unsent-reassigned scan reads its cutoff and its keyset to the millisecond",
    run: async ({ first: one, second }: Instances): Promise<void> => {
      await one.findOrCreateByStepKey(preciseOf("pause-a"));
      const askedAt = new Date(NINE.getTime() + 456);
      const replaced = await second.reassignByTenantIdAndPauseId(
        "default",
        "pause-a",
        { pauseId: "pause-r", assignees: ["x"], seen: seenOf(await stored(second, "pause-a")) },
        askedAt,
        RECIPIENTS,
      );
      expect(replaced?.pauseId).toBe("pause-r");
      const unsent = (cutoff: Date, after?: PauseScanAfter) =>
        second.findPendingUnsentReassignedBefore(cutoff, 10, after).then(idsOf);

      expect(await unsent(off(askedAt, -1))).toEqual([]);
      expect(await unsent(sameAs(askedAt))).toEqual([]);
      expect(await unsent(off(askedAt, 1))).toEqual(["pause-r"]);
      const after = { ...KEY, pauseId: "pause-r" };
      expect(await unsent(off(askedAt, 1000), { ...after, at: off(askedAt, -1) })).toEqual([
        "pause-r",
      ]);
      expect(await unsent(off(askedAt, 1000), { ...after, at: sameAs(askedAt) })).toEqual([]);
      expect(await unsent(off(askedAt, 1000), { ...after, at: off(askedAt, 1) })).toEqual([]);
    },
  },
  {
    name: "#1307: two pauses of one millisecond come in (tenantId, pauseId) order, whichever was made first, and the keyset continues between them",
    run: async ({ first: one, second }: Instances): Promise<void> => {
      // made in the reverse of their order: an insertion-order store fails
      await one.findOrCreateByStepKey(preciseOf("pause-b", "run-1:clerk-agent:1:call-b"));
      await one.findOrCreateByStepKey(preciseOf("pause-a", "run-1:clerk-agent:1:call-a"));
      const due = (after?: PauseScanAfter) =>
        second.findPendingByExpiresAtBefore(off(deadline(), 1), 10, after).then(idsOf);
      const remind = (after?: PauseScanAfter) =>
        second.findPendingByRemindAtBefore(off(reminder(), 1), 10, after).then(idsOf);

      expect(await due()).toEqual(["pause-a", "pause-b"]);
      expect(await remind()).toEqual(["pause-a", "pause-b"]);
      expect(await due({ ...KEY, pauseId: "pause-a", at: sameAs(deadline()) })).toEqual([
        "pause-b",
      ]);
      expect(await due({ ...KEY, pauseId: "pause-b", at: sameAs(deadline()) })).toEqual([]);
      expect(await remind({ ...KEY, pauseId: "pause-a", at: sameAs(reminder()) })).toEqual([
        "pause-b",
      ]);
      expect(await remind({ ...KEY, pauseId: "pause-b", at: sameAs(reminder()) })).toEqual([]);
    },
  },
];
