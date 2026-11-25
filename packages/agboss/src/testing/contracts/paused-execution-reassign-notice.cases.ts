import { expect } from "vitest";
import { PauseClosedReason } from "../../infrastructure/pause-record.js";
import { type PausedExecutionRepository } from "../../infrastructure/paused-execution.repository.js";
import { seconds } from "../../units/index.js";
import type { ContractCase } from "./define.js";
import {
  APPROVED_BY_MANAGER,
  CHANNEL_KEY,
  expiringPauseOf,
  MID,
  NINE,
  pauseOf,
  RECIPIENTS,
  TEN,
} from "./paused-execution-data.js";
import { kindsOf, noticesOf, peeker } from "./paused-execution-mailboxes.js";
import {
  type Instances,
  R,
  AUDIT,
  SLACK,
  reassign,
  treeOf,
  ids,
} from "./paused-execution-reassign-data.js";

/** #946: the notices of a reassignment, the re-send look's scan and the retention. */
export const REASSIGN_NOTICE_CASES: readonly ContractCase<PausedExecutionRepository>[] = [
  {
    name: "a sent old pause writes `closed` (reassigned) to its channel only; the replacement writes nothing until its markSent writes one `reassigned` (no `opened`) to the listeners",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(expiringPauseOf("pause-a"));
      await first.markSentByTenantIdAndPauseId("default", "pause-a", RECIPIENTS);

      await reassign(second, "pause-a", "pause-b", MID);
      const claims = await peeker(first)();

      expect(kindsOf(claims, "pause-a", CHANNEL_KEY)).toEqual(["closed"]);
      // the listeners hear one `reassigned` of the replacement, never the old pause closed
      expect(kindsOf(claims, "pause-a", SLACK)).toEqual(["opened"]);
      expect(noticesOf(claims, "pause-a", CHANNEL_KEY)[0]).toMatchObject({
        reason: PauseClosedReason.Reassigned,
        closedAt: MID.toISOString(),
      });
      expect(claims.filter((claim) => claim.mailbox.pauseId === "pause-b")).toEqual([]);

      expect(await second.markSentByTenantIdAndPauseId("default", "pause-b", RECIPIENTS)).toBe(
        true,
      );
      const after = await peeker(first)();

      expect(kindsOf(after, "pause-b", AUDIT)).toEqual(["reassigned"]);
      expect(noticesOf(after, "pause-b", AUDIT)[0]).toMatchObject({
        previousTarget: "refund-tool-approval",
      });
      expect(kindsOf(after, "pause-b", CHANNEL_KEY)).toEqual([]);
    },
  },
  {
    name: "an unsent old pause writes no notice at the reassignment: its markSent later writes opened then closed (reassigned)",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(expiringPauseOf("pause-a"));

      await reassign(second, "pause-a", "pause-b", MID);
      expect(await peeker(first)()).toEqual([]);
      expect(await first.markSentByTenantIdAndPauseId("default", "pause-a", RECIPIENTS)).toBe(
        false,
      );
      const claims = await peeker(first)();

      expect(kindsOf(claims, "pause-a", CHANNEL_KEY)).toEqual(["closed"]);
      expect(noticesOf(claims, "pause-a", CHANNEL_KEY)[0]).toMatchObject({
        reason: PauseClosedReason.Reassigned,
      });
    },
  },
  {
    name: "findPendingUnsentReassignedBefore: replacements only, still Pending and unsent, made before the cutoff, ascending by (askedAt, tenant, id), at most limit",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(pauseOf("pause-first-send", "run-1:s:1:x"));
      await first.findOrCreateByStepKey(pauseOf("pause-a", "run-1:s:1:a"));
      await first.findOrCreateByStepKey(pauseOf("pause-c", "run-1:s:1:c"));
      await first.findOrCreateByStepKey(pauseOf("pause-e", "run-1:s:1:e"));
      await reassign(first, "pause-a", "pause-b", NINE);
      await reassign(first, "pause-c", "pause-d", TEN);
      await reassign(first, "pause-e", "pause-f", MID);
      const asked = async (cutoff: Date, limit = 10) =>
        (await second.findPendingUnsentReassignedBefore(cutoff, limit)).map(
          (pause) => pause.pauseId,
        );
      const afterTen = new Date(TEN.getTime() + 1);

      // `askedAt < cutoff`, by `askedAt`: the replacement made at the cutoff is not yet due
      expect(await asked(TEN)).toEqual(["pause-b", "pause-f"]);
      expect(await asked(afterTen)).toEqual(["pause-b", "pause-f", "pause-d"]);
      expect(await asked(afterTen, 1)).toEqual(["pause-b"]);
      // sent, answered or reassigned again: no longer asked for
      await second.markSentByTenantIdAndPauseId("default", "pause-b", R);
      await second.resolveByTenantIdAndPauseId("default", "pause-f", APPROVED_BY_MANAGER, MID, R);
      expect(await asked(afterTen)).toEqual(["pause-d"]);
      await reassign(first, "pause-d", "pause-g", TEN);
      expect(await asked(afterTen)).toEqual(["pause-g"]);
    },
  },
  {
    name: "findPendingUnsentReassignedBefore with `after`: more stuck replacements than the limit are all reached, page by page, none twice",
    run: async ({ first, second }: Instances): Promise<void> => {
      const made: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        const old = `pause-o${String(index)}`;
        await first.findOrCreateByStepKey(pauseOf(old, `run-1:s:1:${old}`));
        await reassign(
          first,
          old,
          `pause-n${String(index)}`,
          new Date(NINE.getTime() + index * 1000),
        );
        made.push(`pause-n${String(index)}`);
      }
      const cutoff = new Date(TEN.getTime());
      const reached: string[] = [];
      let after: { at: string; tenantId: string; pauseId: string } | undefined;
      for (;;) {
        const page = await second.findPendingUnsentReassignedBefore(cutoff, 2, after);
        reached.push(...page.map((pause) => pause.pauseId));
        const last = page.at(-1);
        if (page.length < 2 || last === undefined) break;
        after = { at: last.askedAt, tenantId: last.tenantId, pauseId: last.pauseId };
      }

      expect(reached).toEqual(made);
    },
  },
  {
    name: "findPendingUnsentReassignedBefore: a limit outside 1–1000 is a RangeError",
    run: async ({ first }: Instances): Promise<void> => {
      for (const limit of [0, 1001, 1.5])
        await expect(first.findPendingUnsentReassignedBefore(NINE, limit)).rejects.toBeInstanceOf(
          RangeError,
        );
    },
  },
  {
    name: "retention keeps a reassigned pause while its replacement is stored, removes it after, and never a pending replacement",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(pauseOf("pause-a"));
      await reassign(first, "pause-a", "pause-b", NINE);
      const cutoff = new Date(NINE.getTime() + seconds(60));

      await second.deleteByResolvedAtBefore(cutoff);
      expect(ids(await treeOf(first))).toEqual(["pause-a", "pause-b"]);
      expect((await second.findClosedByResolvedAtBefore(cutoff, 10)).pauses).toEqual([]);

      // the replacement answered, taken and aged too: the next sweep removes the chain, oldest first
      await first.resolveByTenantIdAndPauseId("default", "pause-b", APPROVED_BY_MANAGER, TEN, R);
      await first.markTakenByTenantIdAndPauseId("default", "pause-b");
      const later = new Date(TEN.getTime() + seconds(60));
      await second.deleteByResolvedAtBefore(later);
      expect(ids(await treeOf(first))).toEqual(["pause-a"]);
      await second.deleteByResolvedAtBefore(later);
      expect(ids(await treeOf(first))).toEqual([]);
    },
  },
];
