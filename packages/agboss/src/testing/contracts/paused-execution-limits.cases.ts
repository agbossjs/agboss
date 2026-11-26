import { expect } from "vitest";
import { type PausedExecutionRepository } from "../../infrastructure/paused-execution.repository.js";
import type { ContractCase } from "./define.js";
import { expiringPauseOf, MID, withSeenNow } from "./paused-execution-data.js";
import { type Instances, reassignWith, treeOf } from "./paused-execution-reassign-data.js";

/**
 * #1307, Q-D: a pause carries the limits it was opened under (`firstAskedAt`, `maxExpiresAt`,
 * `escalationLimits`); a store keeps them as written, judges every count against them, and a move to
 * another target leaves the replacement with the smaller of them and the destination's offer.
 */

const FIRST = "2026-01-05T08:00:00.000Z";
const CAP = "2026-01-05T20:00:00.000Z";
const LOOSER = "2026-01-06T20:00:00.000Z";
const TIGHTER = "2026-01-05T15:00:00.000Z";
const TO = { target: "tier-one-external-task", respondent: "delegate" as never };

const limitedPause = (pauseId: string, stepKey = "run-1:clerk-agent:1:call-1") => ({
  ...expiringPauseOf(pauseId, stepKey, {
    maxExpiresAt: CAP,
    escalationLimits: { maxExtensions: 4, maxReassignments: 3 },
  }),
  firstAskedAt: FIRST,
});

export const LIMITS_CASES: readonly ContractCase<PausedExecutionRepository>[] = [
  {
    name: "a pause keeps its firstAskedAt, maxExpiresAt and escalationLimits as written",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(limitedPause("pause-a"));
      expect(await second.findByTenantIdAndPauseId("default", "pause-a")).toMatchObject({
        firstAskedAt: FIRST,
        maxExpiresAt: CAP,
        escalationLimits: { maxExtensions: 4, maxReassignments: 3 },
      });
      // no limit on the total wait: none stored, none invented
      await first.findOrCreateByStepKey(expiringPauseOf("pause-b", "run-1:s:1:call-2"));
      const open = await second.findByTenantIdAndPauseId("default", "pause-b");
      expect(open).not.toHaveProperty("maxExpiresAt");
      expect(open?.escalationLimits).toEqual({});
    },
  },
  {
    name: "a move to another target leaves the replacement with the smaller of its limits and the destination's offer, per field",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(limitedPause("pause-a"));
      const made = await reassignWith(
        second,
        "pause-a",
        {
          pauseId: "pause-b",
          to: {
            ...TO,
            limits: {
              maxExpiresAt: TIGHTER,
              escalationLimits: { maxExtensions: 9, maxReassignments: 2 },
            },
          },
        },
        MID,
      );
      // the total wait and the reassignments narrow; the looser extension count frees nothing
      expect(made).toMatchObject({
        firstAskedAt: FIRST,
        maxExpiresAt: TIGHTER,
        escalationLimits: { maxExtensions: 4, maxReassignments: 2 },
      });
      expect(await second.findByTenantIdAndPauseId("default", "pause-b")).toMatchObject({
        maxExpiresAt: TIGHTER,
        escalationLimits: { maxExtensions: 4, maxReassignments: 2 },
      });
    },
  },
  {
    name: "a destination that offers looser limits, or none, loosens nothing; a limit the pause had none of is taken from the destination",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(limitedPause("pause-a"));
      const loose = await reassignWith(
        second,
        "pause-a",
        {
          pauseId: "pause-b",
          to: {
            ...TO,
            limits: { maxExpiresAt: LOOSER, escalationLimits: { maxExtensions: 99 } },
          },
        },
        MID,
      );
      expect(loose).toMatchObject({
        maxExpiresAt: CAP,
        escalationLimits: { maxExtensions: 4, maxReassignments: 3 },
      });
      const none = await reassignWith(
        first,
        "pause-b",
        { pauseId: "pause-c", to: { ...TO, channel: "backup", limits: {} } },
        MID,
      );
      expect(none).toMatchObject({
        maxExpiresAt: CAP,
        escalationLimits: { maxExtensions: 4, maxReassignments: 3 },
      });
      // a pause with no limits takes the destination's
      await first.findOrCreateByStepKey(expiringPauseOf("pause-x", "run-1:s:1:call-2"));
      const taken = await reassignWith(
        first,
        "pause-x",
        {
          pauseId: "pause-y",
          to: { ...TO, limits: { maxExpiresAt: CAP, escalationLimits: { maxReassignments: 5 } } },
        },
        MID,
      );
      expect(taken).toMatchObject({ maxExpiresAt: CAP, escalationLimits: { maxReassignments: 5 } });
    },
  },
  {
    name: "a change in place narrows nothing, and a replacement to the same target without an offer keeps the limits",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(limitedPause("pause-a"));
      const moved = await second.reassignByTenantIdAndPauseId(
        "default",
        "pause-a",
        await withSeenNow(second, "pause-a", { assignees: ["deputy-3"] }),
        MID,
        { listeners: [] },
      );
      expect(moved).toMatchObject({
        firstAskedAt: FIRST,
        maxExpiresAt: CAP,
        escalationLimits: { maxExtensions: 4, maxReassignments: 3 },
      });
      const replaced = await reassignWith(first, "pause-a", { pauseId: "pause-b", to: TO }, MID);
      expect(replaced).toMatchObject({
        firstAskedAt: FIRST,
        maxExpiresAt: CAP,
        escalationLimits: { maxExtensions: 4, maxReassignments: 3 },
      });
    },
  },
  {
    name: "the destination's reassignment count applies at once, atomically: a chain that holds that many reassignments is refused the move, leaving the old pause open",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(limitedPause("pause-a"));
      // one reassignment in place: the chain holds one
      await reassignWith(first, "pause-a", { assignees: ["deputy-3"] }, MID);
      const offer = { limits: { escalationLimits: { maxReassignments: 1 } } };
      expect(
        await reassignWith(second, "pause-a", { pauseId: "pause-b", to: { ...TO, ...offer } }, MID),
      ).toBeUndefined();
      expect(await second.findByTenantIdAndPauseId("default", "pause-b")).toBeUndefined();
      expect((await second.findByTenantIdAndPauseId("default", "pause-a"))?.status).toBe("pending");
      // an offer the chain has room under is taken
      const roomy = { limits: { escalationLimits: { maxReassignments: 2 } } };
      expect(
        await reassignWith(second, "pause-a", { pauseId: "pause-c", to: { ...TO, ...roomy } }, MID),
      ).toMatchObject({ escalationLimits: { maxReassignments: 2 } });
      expect((await treeOf(first)).map((pause) => pause.pauseId).sort()).toEqual([
        "pause-a",
        "pause-c",
      ]);
    },
  },
  {
    name: "the narrowed extension count is what the replacement's own timeout changes are counted against",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(limitedPause("pause-a"));
      // the destination allows one extension: a move that sets a deadline spends it
      const made = await reassignWith(
        second,
        "pause-a",
        {
          pauseId: "pause-b",
          to: { ...TO, limits: { escalationLimits: { maxExtensions: 1 } } },
          timeout: { expiresAt: "2026-01-05T12:00:00.000Z" },
          countsAsExtension: true,
        },
        MID,
      );
      expect(made?.escalationLimits).toEqual({ maxExtensions: 1, maxReassignments: 3 });
      expect(
        await reassignWith(
          first,
          "pause-b",
          {
            assignees: ["deputy-3"],
            timeout: { expiresAt: "2026-01-05T14:00:00.000Z" },
            countsAsExtension: true,
          },
          MID,
        ),
      ).toBeUndefined();
    },
  },
];
