import { expect } from "vitest";
import { NO_RECIPIENTS } from "../../infrastructure/pause-notices.js";
import {
  PauseResolution,
  type PausedExecutionRepository,
} from "../../infrastructure/paused-execution.repository.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./instance-context.js";
import {
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
          s.decideByTenantIdAndPauseId("default", id, DECIDED_ANSWER, BEFORE_DEADLINE),
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
];
