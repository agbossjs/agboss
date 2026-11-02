import { expect } from "vitest";
import { PauseAnswerer } from "../../channels/channel-role.decorator.js";
import type { PauseAnswerRecord } from "../../flow/runtime/execution-record.js";
import { ComponentKind } from "../../flow/runtime/records.js";
import type { ExecutionRecordRepository } from "../../infrastructure/execution-record.repository.js";
import { PauseResolution } from "../../infrastructure/pause-record.js";
import type { ContractCase } from "./define.js";

/**
 * The pause answer log (#267 S107, #676): one answer per pause **of a tree** — a step key names no
 * tree (`<executionId>:<node>:<visit>[:<item>]:<callId>`), so two trees whose ids repeat (#663)
 * share one; each keeps its own answer, and a second save of one tree's pause is ignored.
 */

const STEP_KEY = "child-7:refund-agent:1:call-1";

/** The answer of the refund pause at `STEP_KEY`, by `responder`, decided `approved`. */
const answerOf = (responder: string, approved: boolean): PauseAnswerRecord => ({
  pauseId: undefined,
  executionId: "child-7",
  step: {
    component: {
      name: "refund-agent",
      kind: ComponentKind.Agent,
      promptHash: undefined,
      schemaHash: undefined,
    },
    nodeId: "refund-agent",
    visitNumber: 1,
    idempotencyKey: STEP_KEY,
    callId: "call-1",
    itemIndex: undefined,
    copyNumber: 1,
    toolLoopIteration: 1,
    validationAttempts: 0,
  },
  role: "refund-approval-channel",
  answeredBy: PauseAnswerer.Channel,
  responder,
  resolution: PauseResolution.Replied,
  askedAt: "2026-01-05T09:00:00.000Z",
  resolvedAt: "2026-01-05T09:05:00.000Z",
  decision: { approved },
});

const respondersOf = async (
  records: ExecutionRecordRepository,
  rootExecutionId: string,
): Promise<readonly (string | undefined)[]> =>
  (await records.findPauseAnswersByTenantIdAndRootExecutionId("acme", rootExecutionId)).map(
    (answer) => answer.responder,
  );

export const PAUSE_ANSWER_CASES: readonly ContractCase<ExecutionRecordRepository>[] = [
  {
    name: "#676: two trees whose pauses share a step key each keep their own answer",
    run: async ({ first, second }) => {
      await first.savePauseAnswer("acme", "old-root", answerOf("manager-17", true));
      await second.savePauseAnswer("acme", "new-root", answerOf("manager-21", false));

      expect(await respondersOf(second, "old-root")).toEqual(["manager-17"]);
      expect(await respondersOf(first, "new-root")).toEqual(["manager-21"]);
    },
  },
  {
    name: "#676: one tree's pause is kept once — a second save of it is ignored",
    run: async ({ first, second }) => {
      await first.savePauseAnswer("acme", "root-1", answerOf("manager-17", true));
      await second.savePauseAnswer("acme", "root-1", answerOf("manager-99", false));

      expect(await respondersOf(first, "root-1")).toEqual(["manager-17"]);
      expect(await respondersOf(second, "other-root")).toEqual([]);
    },
  },
];
