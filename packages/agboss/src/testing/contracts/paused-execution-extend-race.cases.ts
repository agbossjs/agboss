import { expect } from "vitest";
import { PauseExpiryBound } from "../../infrastructure/pause-record.js";
import { NO_RECIPIENTS } from "../../infrastructure/pause-notices.js";
import {
  PauseStatus,
  type PausedExecutionRepository,
} from "../../infrastructure/paused-execution.repository.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./instance-context.js";
import {
  APPROVED_BY_MANAGER,
  AFTER_DEADLINE,
  BEFORE_DEADLINE,
  DEADLINE,
  expiringPauseOf,
  MID,
  withSeen,
} from "./paused-execution-data.js";

/**
 * #1099, #1307: a timeout change is one compare-and-set over the deadline the caller read, while the
 * pause is open — of two changes at once from one read one wins and the loser, reading again, applies
 * over the winner's deadline; a change racing the expiry or an answer; the deadline's source reset to
 * `Pause`. What a change may do (shorten, set, take away, `maxExtensions`) is `paused-execution-timeout.cases.ts`.
 */
type Instances = ContractInstances<PausedExecutionRepository>;
const R = NO_RECIPIENTS;
const LATER = "2026-01-05T12:00:00.000Z";
const EVEN_LATER = "2026-01-05T15:00:00.000Z";
/** The deadline of `expiringPauseOf`: what a caller that read the pause holds as the current one. */
const FROM = DEADLINE.toISOString();

export const EXTEND_RACE_CASES: readonly ContractCase<PausedExecutionRepository>[] = [
  {
    name: "an extension whose write happens after the deadline is refused, even to a deadline still ahead of it, nothing written (#1148)",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(expiringPauseOf("pause-a"));
      const extend = async (at: Date) =>
        second.changeTimeoutByTenantIdAndPauseId(
          "default",
          "pause-a",
          await withSeen(second, "pause-a", { expiresAt: EVEN_LATER, previousExpiresAt: FROM }),
          at,
          R,
        );

      expect(await extend(AFTER_DEADLINE)).toBeUndefined();
      expect(await extend(new Date(Date.parse(LATER)))).toBeUndefined();
      expect((await first.findByTenantIdAndPauseId("default", "pause-a"))?.expiresAt).toBe(FROM);
      expect(await extend(BEFORE_DEADLINE)).toMatchObject({ expiresAt: EVEN_LATER });
    },
  },
  {
    name: "extend only over the deadline the caller read: a stale `previousExpiresAt` is refused, nothing written (#1099)",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(expiringPauseOf("pause-a"));
      const extend = async (expiresAt: string, previousExpiresAt: string) =>
        second.changeTimeoutByTenantIdAndPauseId(
          "default",
          "pause-a",
          await withSeen(second, "pause-a", { expiresAt, previousExpiresAt }),
          BEFORE_DEADLINE,
          R,
        );

      expect(await extend(LATER, EVEN_LATER)).toBeUndefined();
      expect(await extend(LATER, FROM)).toMatchObject({ expiresAt: LATER });
      // the one that read the old deadline is late, even with a longer extension
      expect(await extend(EVEN_LATER, FROM)).toBeUndefined();
      expect((await first.findByTenantIdAndPauseId("default", "pause-a"))?.expiresAt).toBe(LATER);
      expect(await extend(EVEN_LATER, LATER)).toMatchObject({ expiresAt: EVEN_LATER });
    },
  },
  {
    name: "two concurrent extends from one read, the longer and the shorter, either order: exactly one wins; the loser reads again and applies over the winner's deadline (#1099, #1307)",
    run: async ({ first, second }: Instances): Promise<void> => {
      for (const [index, longerFirst] of [true, false].entries()) {
        const pauseId = `pause-${String(index)}`;
        await first.findOrCreateByStepKey(expiringPauseOf(pauseId, `run-1:s:${String(index)}`));
        // both read the pause before either writes: one read, two writers
        const { seen } = await withSeen(first, pauseId, {});
        const longer = first.changeTimeoutByTenantIdAndPauseId(
          "default",
          pauseId,
          { expiresAt: EVEN_LATER, previousExpiresAt: FROM, seen },
          BEFORE_DEADLINE,
          R,
        );
        const shorter = second.changeTimeoutByTenantIdAndPauseId(
          "default",
          pauseId,
          { expiresAt: LATER, previousExpiresAt: FROM, seen },
          BEFORE_DEADLINE,
          R,
        );
        const results = longerFirst
          ? await Promise.all([longer, shorter])
          : (await Promise.all([shorter, longer])).reverse();

        expect(results.filter((won) => won !== undefined)).toHaveLength(1);
        const stored = (await first.findByTenantIdAndPauseId("default", pauseId))?.expiresAt;
        // whichever reached the store first won: the longer one in call order on a store that
        // applies calls in order, either one on a store whose two instances race for real
        const longerWon = results[0] !== undefined;
        expect(stored).toBe(longerWon ? EVEN_LATER : LATER);
        // the loser re-reads and applies its own deadline over the winner's: shorter or longer, it goes through
        const loserTo = longerWon ? LATER : EVEN_LATER;
        const retried = await second.changeTimeoutByTenantIdAndPauseId(
          "default",
          pauseId,
          await withSeen(second, pauseId, { expiresAt: loserTo, previousExpiresAt: stored ?? "" }),
          BEFORE_DEADLINE,
          R,
        );
        expect(retried?.expiresAt).toBe(loserTo);
        expect((await first.findByTenantIdAndPauseId("default", pauseId))?.expiresAt).toBe(loserTo);
      }
    },
  },
  {
    name: "extend racing the expiry, and racing an answer: one wins, the loser changes nothing (#1099)",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(expiringPauseOf("pause-a"));
      await first.findOrCreateByStepKey(expiringPauseOf("pause-b", "run-1:s:1:call-2"));
      const extend = async (pauseId: string, at: Date) =>
        first.changeTimeoutByTenantIdAndPauseId(
          "default",
          pauseId,
          await withSeen(first, pauseId, { expiresAt: LATER, previousExpiresAt: FROM }),
          at,
          R,
        );

      const [expired, extendedOrNot] = await Promise.all([
        second.expireByTenantIdAndPauseId("default", "pause-a", {}, DEADLINE, R),
        extend("pause-a", BEFORE_DEADLINE),
      ]);
      const [answered, extendedB] = await Promise.all([
        second.resolveByTenantIdAndPauseId("default", "pause-b", APPROVED_BY_MANAGER, MID, R),
        extend("pause-b", BEFORE_DEADLINE),
      ]);

      // exactly one of each pair applied
      expect([expired, extendedOrNot].filter((won) => won !== undefined)).toHaveLength(1);
      // the answer applies either way (before the extension: it refuses it; after: the pause is still open)
      expect(answered).toBeDefined();
      expect(extendedB === undefined || extendedB.expiresAt === LATER).toBe(true);
      const a = await first.findByTenantIdAndPauseId("default", "pause-a");
      expect(a?.status === PauseStatus.Pending ? a.expiresAt : undefined).toBe(
        extendedOrNot === undefined ? undefined : LATER,
      );
      const b = await first.findByTenantIdAndPauseId("default", "pause-b");
      expect(b?.status).toBe(PauseStatus.Resolved);
    },
  },
  {
    name: "an extension resets the deadline's source to `Pause`, whatever bound the record had (#1099)",
    run: async ({ first, second }: Instances): Promise<void> => {
      const bounds = [PauseExpiryBound.RunDeadline, PauseExpiryBound.Quorum];
      for (const [index, expiryBound] of bounds.entries()) {
        const pauseId = `pause-${String(index)}`;
        await first.findOrCreateByStepKey({
          ...expiringPauseOf(pauseId, `run-1:s:${String(index)}`),
          expiryBound,
          boundAt: EVEN_LATER,
        });

        const moved = await second.changeTimeoutByTenantIdAndPauseId(
          "default",
          pauseId,
          await withSeen(second, pauseId, { expiresAt: LATER, previousExpiresAt: FROM }),
          BEFORE_DEADLINE,
          R,
        );

        expect(moved).toMatchObject({ expiresAt: LATER, expiryBound: PauseExpiryBound.Pause });
        expect((await first.findByTenantIdAndPauseId("default", pauseId))?.expiryBound).toBe(
          PauseExpiryBound.Pause,
        );
      }
    },
  },
];
