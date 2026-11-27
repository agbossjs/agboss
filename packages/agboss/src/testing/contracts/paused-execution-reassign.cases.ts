import { expect } from "vitest";
import {
  PauseResolution,
  PauseStatus,
  type PausedExecutionRepository,
} from "../../infrastructure/paused-execution.repository.js";
import type { ContractCase } from "./define.js";
import {
  decideNow,
  AFTER_DEADLINE,
  APPROVED_BY_MANAGER,
  BEFORE_DEADLINE,
  DEADLINE,
  expiringPauseOf,
  MID,
  pauseOf,
  seenNow,
} from "./paused-execution-data.js";
import {
  type Instances,
  R,
  branchOf,
  reassign,
  treeOf,
  ids,
} from "./paused-execution-reassign-data.js";

/**
 * #946: a reassignment is one transaction — the old pause `Cancelled / Reassigned` pointing at its
 * replacement, the replacement `Pending` and unsent with the old deadline and question under a step
 * key `~r<n>`, the old pause's `closed` notices — judged against the deadline at the write; of two
 * reassignments, or a reassignment and an answer, exactly one wins; the re-send look's scan; a
 * reassigned pause stays while its replacement is stored.
 */
export const REASSIGN_CASES: readonly ContractCase<PausedExecutionRepository>[] = [
  {
    name: "a reassignment closes the old pause Reassigned and makes the replacement: unsent, the old deadline, question and branches, step key ~r1 — on the other instance too",
    run: async ({ first, second }: Instances): Promise<void> => {
      const old = branchOf("pause-a");
      await first.findOrCreateByStepKey(old);

      const replacement = await reassign(second, "pause-a", "pause-b", MID);

      const stored = await first.findByTenantIdAndPauseId("default", "pause-a");
      expect(stored).toBeDefined();
      const { reassignedTo, ...closed } = stored ?? old;
      expect(closed).toEqual({
        ...old,
        status: PauseStatus.Cancelled,
        resolution: PauseResolution.Reassigned,
        resolvedAt: MID,
      });
      expect(reassignedTo).toBe("pause-b");
      const expected = {
        ...old,
        pauseId: "pause-b",
        stepKey: `${old.stepKey}~r1`,
        status: PauseStatus.Pending,
        isSent: false,
        askedAt: MID,
        assignees: ["deputy-3"],
        trail: [
          ...old.trail,
          {
            action: "reassigned",
            at: MID,
            target: old.target,
            channel: old.channel,
            assignees: ["deputy-3"],
            expiresAt: DEADLINE,
          },
        ],
        reassignedFrom: "pause-a",
      };
      expect(replacement).toEqual(expected);
      expect(await second.findByTenantIdAndPauseId("default", "pause-b")).toEqual(expected);
      expect(ids(await treeOf(first))).toEqual(["pause-a", "pause-b"]);
    },
  },
  {
    name: "the step key is still the old pause's: findOrCreateByStepKey of it finds the old pause, never makes a second",
    run: async ({ first, second }: Instances): Promise<void> => {
      const old = pauseOf("pause-a");
      await first.findOrCreateByStepKey(old);
      await reassign(first, "pause-a", "pause-b");

      const again = await second.findOrCreateByStepKey(pauseOf("pause-x", old.stepKey));

      expect(again).toMatchObject({ pauseId: "pause-a", reassignedTo: "pause-b" });
      expect(
        await second.findByTenantIdAndRootExecutionIdAndStepKey(
          "default",
          "run-1",
          `${old.stepKey}~r1`,
        ),
      ).toMatchObject({ pauseId: "pause-b" });
      expect(await second.findByTenantIdAndPauseId("default", "pause-x")).toBeUndefined();
    },
  },
  {
    name: "a second reassignment is ~r2, never ~r1~r1; each replacement points at the pause it replaces (V3.4)",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(pauseOf("pause-a"));
      await reassign(first, "pause-a", "pause-b");

      const third = await reassign(second, "pause-b", "pause-c", BEFORE_DEADLINE, ["deputy-4"]);
      const fourth = await reassign(first, "pause-c", "pause-d", BEFORE_DEADLINE, ["deputy-5"]);

      expect(third).toMatchObject({
        stepKey: "run-1:clerk-agent:1:call-1~r2",
        reassignedFrom: "pause-b",
        assignees: ["deputy-4"],
      });
      expect(fourth?.stepKey).toBe("run-1:clerk-agent:1:call-1~r3");
      expect((await first.findByTenantIdAndPauseId("default", "pause-b"))?.reassignedTo).toBe(
        "pause-c",
      );
    },
  },
  {
    name: "a step key already taken by another pause of the tree is skipped: n is the next free number",
    run: async ({ first }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(pauseOf("pause-a"));
      await first.findOrCreateByStepKey(pauseOf("pause-z", "run-1:clerk-agent:1:call-1~r1"));

      const replacement = await reassign(first, "pause-a", "pause-b");

      expect(replacement?.stepKey).toBe("run-1:clerk-agent:1:call-1~r2");
    },
  },
  {
    name: "refused, nothing written: a pause that is Resolved, Cancelled, Taken, unknown or another tenant's, and one whose deadline is at or before `at`",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(expiringPauseOf("pause-a", "run-1:s:1:a"));
      await first.resolveByTenantIdAndPauseId("default", "pause-a", APPROVED_BY_MANAGER, MID, R);
      await first.findOrCreateByStepKey(expiringPauseOf("pause-b", "run-1:s:1:b"));
      await first.cancelByTenantIdAndPauseId(
        "default",
        "pause-b",
        PauseResolution.Withdrawn,
        MID,
        R,
      );
      await first.findOrCreateByStepKey(expiringPauseOf("pause-c", "run-1:s:1:c"));
      await decideNow(first, "pause-c", APPROVED_BY_MANAGER, MID);
      await first.findOrCreateByStepKey(expiringPauseOf("pause-d", "run-1:s:1:d"));
      const before = ids(await treeOf(first));

      expect(await reassign(second, "pause-a", "pause-r1")).toBeUndefined();
      expect(await reassign(second, "pause-b", "pause-r2")).toBeUndefined();
      expect(await reassign(second, "pause-c", "pause-r3")).toBeUndefined();
      expect(await reassign(second, "no-pause", "pause-r4")).toBeUndefined();
      // exactly at the deadline it is over, as for an answer (I2); and after it
      expect(await reassign(second, "pause-d", "pause-r5", DEADLINE)).toBeUndefined();
      expect(await reassign(second, "pause-d", "pause-r6", AFTER_DEADLINE)).toBeUndefined();
      expect(
        await second.reassignByTenantIdAndPauseId(
          "acme",
          "pause-d",
          { pauseId: "pause-r7", assignees: ["deputy-3"], seen: await seenNow(second, "pause-d") },
          BEFORE_DEADLINE,
          R,
        ),
      ).toBeUndefined();

      expect(ids(await treeOf(first))).toEqual(before);
      expect((await first.findByTenantIdAndPauseId("default", "pause-d"))?.status).toBe(
        PauseStatus.Pending,
      );
      expect(await first.findByTenantIdAndPauseId("default", "pause-r5")).toBeUndefined();
    },
  },
  {
    name: "a pause without a deadline is reassigned, and its replacement has none",
    run: async ({ first }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(pauseOf("pause-a"));

      const replacement = await reassign(
        first,
        "pause-a",
        "pause-b",
        new Date("2030-01-01T00:00:00.000Z"),
      );

      expect(replacement?.expiresAt).toBeUndefined();
      expect(replacement?.status).toBe(PauseStatus.Pending);
    },
  },
];
