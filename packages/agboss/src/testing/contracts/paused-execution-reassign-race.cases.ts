import { expect } from "vitest";
import {
  PauseResolution,
  PauseStatus,
  type PausedExecutionRepository,
  type PauseRecord,
} from "../../infrastructure/paused-execution.repository.js";
import type { ContractCase } from "./define.js";
import {
  APPROVED_BY_MANAGER,
  BEFORE_DEADLINE,
  DEADLINE,
  expiringPauseOf,
  MID,
  RECIPIENTS,
} from "./paused-execution-data.js";
import { type Instances, R, reassign, treeOf, winners } from "./paused-execution-reassign-data.js";

/** #946: two reassignments, a reassignment and an answer, and what the old pause refuses after it. */
export const REASSIGN_RACE_CASES: readonly ContractCase<PausedExecutionRepository>[] = [
  {
    name: "two reassignments of one pause at once, from both instances: exactly one wins, the tree has one replacement, either order",
    run: async ({ first, second }: Instances): Promise<void> => {
      for (const [index, firstGoesFirst] of [true, false].entries()) {
        const old = `pause-${String(index)}`;
        await first.findOrCreateByStepKey(expiringPauseOf(old, `run-1:s:${String(index)}`));
        const one = (): Promise<PauseRecord | undefined> =>
          first.reassignByTenantIdAndPauseId(
            "default",
            old,
            { pauseId: `${old}-one`, assignee: "deputy-1" },
            BEFORE_DEADLINE,
            RECIPIENTS,
          );
        const two = (): Promise<PauseRecord | undefined> =>
          second.reassignByTenantIdAndPauseId(
            "default",
            old,
            { pauseId: `${old}-two`, assignee: "deputy-2" },
            BEFORE_DEADLINE,
            RECIPIENTS,
          );

        // started in this order, both at once
        const started = firstGoesFirst ? [one(), two()] : [two(), one()];
        const outcomes = await Promise.all(started);

        expect(winners(outcomes)).toBe(1);
        const replaced = (await treeOf(first)).filter((pause) => pause.reassignedFrom === old);
        expect(replaced).toHaveLength(1);
        const [won] = replaced;
        expect((await first.findByTenantIdAndPauseId("default", old))?.reassignedTo).toBe(
          won?.pauseId,
        );
        expect(won?.stepKey).toBe(`run-1:s:${String(index)}~r1`);
      }
    },
  },
  {
    name: "a reassignment and an answer at once: exactly one wins; whichever wins, the pause leaves Pending once and no second replacement exists",
    run: async ({ first, second }: Instances): Promise<void> => {
      for (const [index, answerFirst] of [true, false].entries()) {
        const old = `pause-${String(index)}`;
        await first.findOrCreateByStepKey(expiringPauseOf(old, `run-1:s:${String(index)}`));
        const answer = (): Promise<PauseRecord | undefined> =>
          first.resolveByTenantIdAndPauseId(
            "default",
            old,
            APPROVED_BY_MANAGER,
            BEFORE_DEADLINE,
            RECIPIENTS,
          );
        const move = (): Promise<PauseRecord | undefined> => reassign(second, old, `${old}-new`);

        // started in this order, both at once
        const started = answerFirst
          ? { answered: answer(), moved: move() }
          : { moved: move(), answered: answer() };
        const [answered, moved] = [await started.answered, await started.moved];

        expect([answered, moved].filter((one) => one !== undefined)).toHaveLength(1);
        const stored = await first.findByTenantIdAndPauseId("default", old);
        expect(stored?.resolution).toBe(
          moved === undefined ? PauseResolution.Replied : PauseResolution.Reassigned,
        );
        const found = await first.findByTenantIdAndPauseId("default", `${old}-new`);
        expect(found === undefined).toBe(moved === undefined);
      }
    },
  },
  {
    name: "after a reassignment the old pause takes no answer, no second reassignment and no extension; its replacement takes them",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(expiringPauseOf("pause-a"));
      await reassign(first, "pause-a", "pause-b");

      expect(
        await second.resolveByTenantIdAndPauseId("default", "pause-a", APPROVED_BY_MANAGER, MID, R),
      ).toBeUndefined();
      expect(await reassign(second, "pause-a", "pause-c")).toBeUndefined();
      expect(
        await second.extendByTenantIdAndPauseId(
          "default",
          "pause-a",
          { expiresAt: "2026-01-05T12:00:00.000Z", previousExpiresAt: DEADLINE.toISOString() },
          MID,
          R,
        ),
      ).toBeUndefined();
      const answered = await second.resolveByTenantIdAndPauseId(
        "default",
        "pause-b",
        APPROVED_BY_MANAGER,
        MID,
        R,
      );

      expect(answered).toMatchObject({ status: PauseStatus.Resolved, pauseId: "pause-b" });
    },
  },
  {
    name: "the replacement keeps the deadline: it expires at the old pause's, and not before",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(expiringPauseOf("pause-a"));
      await reassign(first, "pause-a", "pause-b", MID);

      expect(await second.findPendingByExpiresAtBefore(BEFORE_DEADLINE, 10)).toEqual([]);
      const due = await second.findPendingByExpiresAtBefore(DEADLINE, 10);

      expect(due.map((pause) => pause.pauseId)).toEqual(["pause-b"]);
      expect(
        await second.expireByTenantIdAndPauseId("default", "pause-b", {}, DEADLINE, R),
      ).toMatchObject({ resolution: PauseResolution.Expired });
    },
  },
];
