import { expect } from "vitest";
import { NO_RECIPIENTS } from "../../infrastructure/pause-notices.js";
import {
  PauseResolution,
  PauseStatus,
  type PausedExecutionRepository,
} from "../../infrastructure/paused-execution.repository.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./instance-context.js";
import {
  decideNow,
  AFTER_DEADLINE,
  APPROVED_BY_MANAGER,
  BEFORE_DEADLINE,
  DEADLINE,
  DECIDED_ANSWER,
  expiringPauseOf,
} from "./paused-execution-data.js";

/** #910 I1: a pause leaves Pending exactly once, whichever two closers race. */
const R = NO_RECIPIENTS;
type Case = ContractCase<PausedExecutionRepository>;
type Instances = ContractInstances<PausedExecutionRepository>;

export const CLOSER_RACE_CASES: readonly Case[] = [
  {
    name: "of two closers of one pause on two instances exactly one applies, whichever pair",
    run: async ({ first, second }: Instances): Promise<void> => {
      const closers = {
        resolve: (s: PausedExecutionRepository, id: string) =>
          s.resolveByTenantIdAndPauseId("default", id, APPROVED_BY_MANAGER, BEFORE_DEADLINE, R),
        withdraw: (s: PausedExecutionRepository, id: string) =>
          s.cancelByTenantIdAndPauseId(
            "default",
            id,
            PauseResolution.Withdrawn,
            BEFORE_DEADLINE,
            R,
          ),
        decide: (s: PausedExecutionRepository, id: string) =>
          decideNow(s, id, DECIDED_ANSWER, BEFORE_DEADLINE),
        expire: (s: PausedExecutionRepository, id: string) =>
          s.expireByTenantIdAndPauseId("default", id, {}, DEADLINE, R),
        expireAgain: (s: PausedExecutionRepository, id: string) =>
          s.expireByTenantIdAndPauseId("default", id, {}, DEADLINE, R),
        cancel: (s: PausedExecutionRepository, id: string) =>
          s.cancelByTenantIdAndPauseId("default", id, PauseResolution.Cancelled, DEADLINE, R),
      };
      const pairs = [
        ["resolve", "withdraw"],
        ["resolve", "decide"],
        ["withdraw", "decide"],
        ["expire", "expireAgain"],
        ["expire", "cancel"],
      ] as const;
      for (const [index, [one, other]] of pairs.entries()) {
        const id = `pause-${String(index)}`;
        await first.findOrCreateByStepKey(expiringPauseOf(id, `run-1:s:1:call-${String(index)}`));

        const results = await Promise.all([closers[one](first, id), closers[other](second, id)]);

        expect(
          results.filter((result) => result !== undefined && result !== false),
          `${one} vs ${other}`,
        ).toHaveLength(1);
      }
    },
  },
  {
    name: "a channel's decision at once is taken only while the deadline is ahead, as an answer is (I2): at or after it the pause stays Pending for its expiry",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(expiringPauseOf("pause-a"));

      // exactly at the deadline it is over, and after it
      expect(await decideNow(second, "pause-a", DECIDED_ANSWER, DEADLINE)).toBe(false);
      expect(await decideNow(second, "pause-a", DECIDED_ANSWER, AFTER_DEADLINE)).toBe(false);
      const refused = await first.findByTenantIdAndPauseId("default", "pause-a");
      expect(refused).toMatchObject({ status: PauseStatus.Pending });
      expect(refused?.answer).toBeUndefined();
      expect(refused?.resolution).toBeUndefined();

      // the expiry takes it; a decision after the expiry is refused too, and the one before it applies
      expect(
        await first.expireByTenantIdAndPauseId("default", "pause-a", {}, AFTER_DEADLINE, R),
      ).toMatchObject({ resolution: PauseResolution.Expired });
      expect(await decideNow(second, "pause-a", DECIDED_ANSWER, BEFORE_DEADLINE)).toBe(false);
      await first.findOrCreateByStepKey(expiringPauseOf("pause-b", "run-1:s:1:call-2"));
      expect(await decideNow(second, "pause-b", DECIDED_ANSWER, BEFORE_DEADLINE)).toBe(true);
    },
  },
];
