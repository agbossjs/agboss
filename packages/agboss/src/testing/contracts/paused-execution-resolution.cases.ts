import { expect } from "vitest";
import {
  PauseResolution,
  PauseStatus,
  type PausedExecutionRepository,
} from "../../infrastructure/paused-execution.repository.js";
import type { UsageRecord } from "../../finops/usage.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./seam.js";

/** What each case below gets. */
type Instances = ContractInstances<PausedExecutionRepository>;
import {
  APPROVED_BY_MANAGER,
  DECIDED_ANSWER,
  NINE,
  pauseOf,
  TEN,
} from "./paused-execution-data.js";

/** #265 AC11 / #267 AC12: a pause goes from Pending to Resolved once. */
export const PAUSE_TRANSITION_CASES: readonly ContractCase<PausedExecutionRepository>[] = [
  {
    name: "of two concurrent transitions of one pause on two instances exactly one succeeds, with its decision",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(pauseOf("pause-a"));
      const no = { decision: { approved: false }, answerer: "manager-18" };

      const [one, other] = await Promise.all([
        first.resolveByTenantIdAndPauseId("default", "pause-a", APPROVED_BY_MANAGER, NINE),
        second.resolveByTenantIdAndPauseId("default", "pause-a", no, NINE),
      ]);

      // two instances are two connections: which answer reaches the store first is not the call
      // order (#704) — exactly one resolves the pause, and the stored pause holds that one's answer
      const outcomes = [one, other].filter((pause) => pause !== undefined);
      expect(outcomes).toHaveLength(1);
      const replied = {
        status: PauseStatus.Resolved,
        answer: one === undefined ? no : APPROVED_BY_MANAGER,
        resolution: PauseResolution.Replied,
        resolvedAt: NINE.toISOString(),
      };
      expect(outcomes[0]).toMatchObject(replied);
      expect(await second.findByTenantIdAndPauseId("default", "pause-a")).toMatchObject(replied);
      expect(
        await first.resolveByTenantIdAndPauseId(
          "default",
          "no-such-pause",
          APPROVED_BY_MANAGER,
          NINE,
        ),
      ).toBeUndefined();
    },
  },
  {
    name: "a fast reply before `send` returns: markSent does not overwrite the resolved pause",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(pauseOf("pause-a"));

      await second.resolveByTenantIdAndPauseId("default", "pause-a", DECIDED_ANSWER, NINE);
      const marked = await first.markSentByTenantIdAndPauseId("default", "pause-a");

      expect(marked).toBe(false);
      expect(await first.findByTenantIdAndPauseId("default", "pause-a")).toMatchObject({
        status: PauseStatus.Resolved,
        isSent: false,
        answer: { decision: { approved: true } },
      });
    },
  },
  {
    name: "a cancelled pause takes no answer and cannot be cancelled again",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(pauseOf("pause-a"));

      const withdrawn = PauseResolution.Withdrawn;
      expect(await first.cancelByTenantIdAndPauseId("default", "pause-a", withdrawn, NINE)).toBe(
        true,
      );
      const cancelled = PauseResolution.Cancelled;
      expect(await second.cancelByTenantIdAndPauseId("default", "pause-a", cancelled, TEN)).toBe(
        false,
      );
      expect(
        await second.resolveByTenantIdAndPauseId("default", "pause-a", APPROVED_BY_MANAGER, TEN),
      ).toBeUndefined();
      expect(await second.findByTenantIdAndPauseId("default", "pause-a")).toMatchObject({
        status: PauseStatus.Cancelled,
        resolution: PauseResolution.Withdrawn,
        resolvedAt: NINE.toISOString(),
      });
    },
  },
];

/** What reading a free-text reply cost: one call of a reply interpreter. */
const INTERPRETER_CALL: UsageRecord = {
  caller: "reply-interpreter:refund-reply-interpreter",
  model: "test/interpreter",
  inputTokens: 10,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.01,
  costSource: "api",
};

/** #267 S107: how each pause was resolved, and how long it is kept. */
export const PAUSE_RECORD_CASES: readonly ContractCase<PausedExecutionRepository>[] = [
  {
    name: "a pause its channel decided at once is Taken, Decided, with the channel's decision",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(pauseOf("pause-a"));

      expect(
        await second.decideByTenantIdAndPauseId("default", "pause-a", DECIDED_ANSWER, NINE),
      ).toBe(true);
      expect(
        await first.decideByTenantIdAndPauseId("default", "pause-a", DECIDED_ANSWER, TEN),
      ).toBe(false);

      expect(await first.findByTenantIdAndPauseId("default", "pause-a")).toMatchObject({
        status: PauseStatus.Taken,
        resolution: PauseResolution.Decided,
        answer: { decision: { approved: true } },
        resolvedAt: NINE.toISOString(),
      });
    },
  },
  {
    name: "an answer keeps what reading its reply cost; the tree lists its pauses in the order asked",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(pauseOf("pause-b", "run-1:clerk-agent:1:call-2"));
      await first.findOrCreateByStepKey(pauseOf("pause-a"));
      const answer = { ...APPROVED_BY_MANAGER, usage: [INTERPRETER_CALL] };

      await second.resolveByTenantIdAndPauseId("default", "pause-a", answer, NINE);

      const tree = await first.findAllByTenantIdAndRootExecutionId("default", "run-1");
      expect(tree.map((pause) => pause.pauseId)).toEqual(["pause-b", "pause-a"]);
      expect(tree[1]?.answer).toEqual(answer);
    },
  },
  {
    name: "deleteResolvedBefore removes Taken and Cancelled records resolved before the cutoff only",
    run: async ({ first, second }: Instances): Promise<void> => {
      const keys = ["a", "b", "c", "d", "e"].map((id) => `run-1:clerk-agent:1:call-${id}`);
      for (const [index, key] of keys.entries())
        await first.findOrCreateByStepKey(pauseOf(`pause-${String(index)}`, key));
      await first.decideByTenantIdAndPauseId("default", "pause-0", DECIDED_ANSWER, NINE);
      await first.cancelByTenantIdAndPauseId("default", "pause-1", PauseResolution.Cancelled, NINE);
      await first.resolveByTenantIdAndPauseId("default", "pause-2", APPROVED_BY_MANAGER, NINE);
      await first.decideByTenantIdAndPauseId("default", "pause-3", DECIDED_ANSWER, TEN);

      await second.deleteResolvedBefore(new Date("2026-01-05T09:30:00.000Z"));

      const left = await first.findAllByTenantIdAndRootExecutionId("default", "run-1");
      // the resolved one not taken yet and the pending one stay, whatever their age
      expect(left.map((pause) => pause.pauseId)).toEqual(["pause-2", "pause-3", "pause-4"]);
    },
  },
];
