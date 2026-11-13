import { expect } from "vitest";
import { ExpiryProblem } from "../../infrastructure/pause-record.js";
import { NO_RECIPIENTS } from "../../infrastructure/pause-notices.js";
import {
  PauseResolution,
  PauseStatus,
  type PausedExecutionRepository,
} from "../../infrastructure/paused-execution.repository.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./instance-context.js";
import {
  AFTER_DEADLINE,
  APPROVED_BY_MANAGER,
  BEFORE_DEADLINE,
  DEADLINE,
  DECIDED_ANSWER,
  expiringPauseOf,
  pauseOf,
} from "./paused-execution-data.js";

/** #910 AC1, I1–I3: the deadline is part of the compare-and-set of every closer. */
const R = NO_RECIPIENTS;
type Case = ContractCase<PausedExecutionRepository>;
type Instances = ContractInstances<PausedExecutionRepository>;

export const DEADLINE_CASES: readonly Case[] = [
  {
    name: "an answer 1 ms before the deadline is taken, at it refused, on the other instance",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(expiringPauseOf("pause-a"));

      // at the deadline the pause is already closed to answers, whichever call reaches the store first
      const [refused, taken] = await Promise.all([
        second.resolveByTenantIdAndPauseId("default", "pause-a", APPROVED_BY_MANAGER, DEADLINE, R),
        first.resolveByTenantIdAndPauseId(
          "default",
          "pause-a",
          APPROVED_BY_MANAGER,
          BEFORE_DEADLINE,
          R,
        ),
      ]);
      const reversed = await second.findByTenantIdAndPauseId("default", "pause-a");

      expect(taken).toMatchObject({
        status: PauseStatus.Resolved,
        resolution: PauseResolution.Replied,
      });
      expect(refused).toBeUndefined();
      expect(reversed?.resolvedAt).toBe(BEFORE_DEADLINE.toISOString());
    },
  },
  {
    name: "resolve at `expiresAt` and after does not apply, the pause stays Pending",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(expiringPauseOf("pause-a"));

      for (const at of [DEADLINE, AFTER_DEADLINE])
        expect(
          await second.resolveByTenantIdAndPauseId(
            "default",
            "pause-a",
            APPROVED_BY_MANAGER,
            at,
            R,
          ),
        ).toBeUndefined();

      expect(await first.findByTenantIdAndPauseId("default", "pause-a")).toMatchObject({
        status: PauseStatus.Pending,
      });
    },
  },
  {
    name: "a pause without `expiresAt` resolves at any time",
    run: async ({ first }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(pauseOf("pause-a"));

      const far = new Date("2099-01-01T00:00:00.000Z");
      expect(
        await first.resolveByTenantIdAndPauseId("default", "pause-a", APPROVED_BY_MANAGER, far, R),
      ).toMatchObject({ status: PauseStatus.Resolved });
    },
  },
  {
    name: "two instances race resolve vs expire at `expiresAt` + 1 ms: only expire applies",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(expiringPauseOf("pause-a"));

      const [resolved, expired] = await Promise.all([
        first.resolveByTenantIdAndPauseId(
          "default",
          "pause-a",
          APPROVED_BY_MANAGER,
          AFTER_DEADLINE,
          R,
        ),
        second.expireByTenantIdAndPauseId("default", "pause-a", {}, AFTER_DEADLINE, R),
      ]);

      expect(resolved).toBeUndefined();
      expect(expired).toMatchObject({
        status: PauseStatus.Cancelled,
        resolution: PauseResolution.Expired,
      });
    },
  },
  {
    name: "cancel Cancelled or TreeEnded at or after `expiresAt` records Expired; Withdrawn records Withdrawn",
    run: async ({ first, second }: Instances): Promise<void> => {
      const resolutions = [
        PauseResolution.Cancelled,
        PauseResolution.TreeEnded,
        PauseResolution.Withdrawn,
      ] as const;
      for (const index of resolutions.keys())
        await first.findOrCreateByStepKey(
          expiringPauseOf(`pause-${String(index)}`, `run-1:s:1:call-${String(index)}`),
        );

      const at = [DEADLINE, AFTER_DEADLINE, AFTER_DEADLINE] as const;
      const closed = await Promise.all(
        resolutions.map((resolution, index) =>
          second.cancelByTenantIdAndPauseId(
            "default",
            `pause-${String(index)}`,
            resolution,
            at[index] ?? DEADLINE,
            R,
          ),
        ),
      );

      expect(closed.map((pause) => pause?.resolution)).toEqual([
        PauseResolution.Expired,
        PauseResolution.Expired,
        PauseResolution.Withdrawn,
      ]);
      expect(closed.map((pause) => pause?.status)).toEqual(Array(3).fill(PauseStatus.Cancelled));
    },
  },
  {
    name: "cancel before `expiresAt` records what it was asked",
    run: async ({ first }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(expiringPauseOf("pause-a"));

      expect(
        await first.cancelByTenantIdAndPauseId(
          "default",
          "pause-a",
          PauseResolution.TreeEnded,
          BEFORE_DEADLINE,
          R,
        ),
      ).toMatchObject({ resolution: PauseResolution.TreeEnded });
    },
  },
  {
    name: "expire before `expiresAt` does not apply; at it with an answer → Resolved / DecidedOnExpiry, without → Cancelled / Expired",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(expiringPauseOf("pause-a"));
      await first.findOrCreateByStepKey(expiringPauseOf("pause-b", "run-1:s:1:call-2"));

      expect(
        await second.expireByTenantIdAndPauseId("default", "pause-a", {}, BEFORE_DEADLINE, R),
      ).toBeUndefined();
      const decided = await second.expireByTenantIdAndPauseId(
        "default",
        "pause-a",
        { answer: APPROVED_BY_MANAGER },
        DEADLINE,
        R,
      );
      const failed = await first.expireByTenantIdAndPauseId(
        "default",
        "pause-b",
        { problem: ExpiryProblem.HandlerTimeout },
        DEADLINE,
        R,
      );

      expect(decided).toMatchObject({
        status: PauseStatus.Resolved,
        resolution: PauseResolution.DecidedOnExpiry,
        answer: { decision: DECIDED_ANSWER.decision, answeredBy: undefined },
        resolvedAt: DEADLINE.toISOString(),
      });
      expect(failed).toMatchObject({
        status: PauseStatus.Cancelled,
        resolution: PauseResolution.Expired,
        expiryProblem: ExpiryProblem.HandlerTimeout,
      });
    },
  },
];
