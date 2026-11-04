import { expect } from "vitest";
import {
  PauseResolution,
  PauseStatus,
  type PausedExecutionRepository,
} from "../../infrastructure/paused-execution.repository.js";
import type { ContractCase } from "./define.js";
import { NINE, QUESTION_ANSWER, questionPauseOf } from "./paused-execution-data.js";

/**
 * #746: a question role's pause (#659 a flow step, #712 an agent's tool) — no tool call in its ask,
 * the role as its component — is kept, found and resolved like an approval's, as written.
 */
export const QUESTION_PAUSE_CASES: readonly ContractCase<PausedExecutionRepository>[] = [
  {
    name: "#746: a question's pause is found on the other instance as written — by id and by its tree",
    run: async ({ first, second }) => {
      const asked = questionPauseOf("pause-q");

      expect(await first.findOrCreateByStepKey(asked)).toEqual(asked);

      expect(await second.findByTenantIdAndPauseId("default", "pause-q")).toEqual(asked);
      expect(await second.findAllByTenantIdAndRootExecutionId("default", "run-1")).toEqual([asked]);
      expect((await second.findOrCreateByStepKey(questionPauseOf("pause-r"))).pauseId).toBe(
        "pause-q",
      );
    },
  },
  {
    name: "#746: a question's pause is sent, answered with the role's answer and taken like any pause",
    run: async ({ first, second }) => {
      await first.findOrCreateByStepKey(questionPauseOf("pause-q"));

      expect(await second.markSentByTenantIdAndPauseId("default", "pause-q")).toBe(true);
      const resolved = await first.resolveByTenantIdAndPauseId(
        "default",
        "pause-q",
        QUESTION_ANSWER,
        NINE,
      );
      expect(resolved?.status).toBe(PauseStatus.Resolved);
      await second.markTakenByTenantIdAndPauseId("default", "pause-q");

      expect(await first.findByTenantIdAndPauseId("default", "pause-q")).toEqual({
        ...questionPauseOf("pause-q"),
        isSent: true,
        status: PauseStatus.Taken,
        answer: QUESTION_ANSWER,
        resolution: PauseResolution.Replied,
        resolvedAt: NINE.toISOString(),
      });
    },
  },
];
