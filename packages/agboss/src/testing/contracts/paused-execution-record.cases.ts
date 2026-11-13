import { expect } from "vitest";
import { NO_RECIPIENTS } from "../../infrastructure/pause-notices.js";
import {
  PauseResolution,
  PauseStatus,
  type PausedExecutionRepository,
} from "../../infrastructure/paused-execution.repository.js";
import { CostSource, type UsageRecord } from "../../finops/usage.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./instance-context.js";
import {
  APPROVED_BY_MANAGER,
  DECIDED_ANSWER,
  NINE,
  pauseOf,
  TEN,
} from "./paused-execution-data.js";

type Instances = ContractInstances<PausedExecutionRepository>;

/** What reading a free-text reply cost: one call of a reply interpreter. */
const INTERPRETER_CALL: UsageRecord = {
  caller: "reply-interpreter:refund-reply-interpreter",
  model: "test/interpreter",
  inputTokens: 10,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.01,
  costSource: CostSource.Api,
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

      await second.resolveByTenantIdAndPauseId("default", "pause-a", answer, NINE, NO_RECIPIENTS);

      const tree = await first.findAllByTenantIdAndRootExecutionId("default", "run-1");
      expect(tree.map((pause) => pause.pauseId)).toEqual(["pause-b", "pause-a"]);
      expect(tree[1]?.answer).toEqual(answer);
    },
  },
  {
    name: "deleteByResolvedAtBefore removes Taken and Cancelled records resolved before the cutoff only",
    run: async ({ first, second }: Instances): Promise<void> => {
      const keys = ["a", "b", "c", "d", "e"].map((id) => `run-1:clerk-agent:1:call-${id}`);
      for (const [index, key] of keys.entries())
        await first.findOrCreateByStepKey(pauseOf(`pause-${String(index)}`, key));
      await first.decideByTenantIdAndPauseId("default", "pause-0", DECIDED_ANSWER, NINE);
      await first.cancelByTenantIdAndPauseId(
        "default",
        "pause-1",
        PauseResolution.Cancelled,
        NINE,
        NO_RECIPIENTS,
      );
      await first.resolveByTenantIdAndPauseId(
        "default",
        "pause-2",
        APPROVED_BY_MANAGER,
        NINE,
        NO_RECIPIENTS,
      );
      await first.decideByTenantIdAndPauseId("default", "pause-3", DECIDED_ANSWER, TEN);

      await second.deleteByResolvedAtBefore(new Date("2026-01-05T09:30:00.000Z"));

      const left = await first.findAllByTenantIdAndRootExecutionId("default", "run-1");
      // the resolved one not taken yet and the pending one stay, whatever their age
      expect(left.map((pause) => pause.pauseId)).toEqual(["pause-2", "pause-3", "pause-4"]);
    },
  },
  {
    name: "#890 AC5: a Resolved pause marked Taken keeps its answer and goes with deleteByResolvedAtBefore",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(pauseOf("pause-a"));
      await first.resolveByTenantIdAndPauseId(
        "default",
        "pause-a",
        APPROVED_BY_MANAGER,
        NINE,
        NO_RECIPIENTS,
      );

      await second.markTakenByTenantIdAndPauseId("default", "pause-a");

      expect(await first.findByTenantIdAndPauseId("default", "pause-a")).toMatchObject({
        status: PauseStatus.Taken,
        resolution: PauseResolution.Replied,
        answer: APPROVED_BY_MANAGER,
      });
      await second.deleteByResolvedAtBefore(new Date("2026-01-05T09:30:00.000Z"));
      expect(await first.findByTenantIdAndPauseId("default", "pause-a")).toBeUndefined();
    },
  },
];
