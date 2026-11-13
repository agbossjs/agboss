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
const answerOf = (
  responder: string,
  approved: boolean,
  key = STEP_KEY,
  askedAt = "2026-01-05T09:00:00.000Z",
): PauseAnswerRecord => ({
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
    idempotencyKey: key,
    callId: "call-1",
    itemIndex: undefined,
    copyNumber: 1,
    toolLoopIteration: 1,
    validationAttempts: 0,
  },
  role: "refund-approval-channel",
  answerer: PauseAnswerer.Channel,
  answeredBy: responder,
  responder,
  resolution: PauseResolution.Replied,
  askedAt,
  resolvedAt: "2026-01-05T09:05:00.000Z",
  decision: { approved },
});

const respondersOf = async (
  records: ExecutionRecordRepository,
  rootExecutionId: string,
): Promise<readonly (string | undefined)[]> =>
  (await records.findPauseAnswersByTenantIdAndRootExecutionId("acme", rootExecutionId)).map(
    (answer) => answer.answeredBy,
  );

const CASES: readonly ContractCase<ExecutionRecordRepository>[] = [
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
  {
    name: "I12: save then markNotTaken → not taken, answer and answeredBy kept",
    run: async ({ first, second }) => {
      await first.savePauseAnswer("acme", "root-1", answerOf("manager-17", true));

      await second.markPauseAnswerNotTaken("acme", "root-1", {
        ...answerOf("manager-17", true),
        isTaken: false,
      });

      const [entry, ...rest] = await first.findPauseAnswersByTenantIdAndRootExecutionId(
        "acme",
        "root-1",
      );
      expect(rest).toEqual([]);
      expect(entry).toMatchObject({
        isTaken: false,
        answeredBy: "manager-17",
        decision: { approved: true },
      });
    },
  },
  {
    name: "I12: markNotTaken then save → not taken (the save is ignored)",
    run: async ({ first, second }) => {
      await first.markPauseAnswerNotTaken("acme", "root-1", {
        ...answerOf("manager-17", true),
        isTaken: false,
      });

      await second.savePauseAnswer("acme", "root-1", answerOf("manager-99", false));

      const entries = await second.findPauseAnswersByTenantIdAndRootExecutionId("acme", "root-1");
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        isTaken: false,
        answeredBy: "manager-17",
        decision: { approved: true },
      });
    },
  },
  {
    name: "I12: two instances write the answer and the not-taken mark at once, either order: not taken wins",
    run: async ({ first, second }) => {
      for (const [root, swap] of [
        ["root-a", false],
        ["root-b", true],
      ] as const) {
        const save = (swap ? second : first).savePauseAnswer(
          "acme",
          root,
          answerOf("manager-17", true),
        );
        const mark = (swap ? first : second).markPauseAnswerNotTaken("acme", root, {
          ...answerOf("manager-17", true),
          isTaken: false,
        });
        await Promise.all([save, mark]);

        const entries = await first.findPauseAnswersByTenantIdAndRootExecutionId("acme", root);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ isTaken: false, answeredBy: "manager-17" });
      }
    },
  },
  {
    name: "I12: the not-taken entry keeps its place in the tree's order",
    run: async ({ first, second }) => {
      const early = answerOf(
        "manager-1",
        true,
        "child-7:refund-agent:1:call-1",
        "2026-01-05T09:00:00.000Z",
      );
      const late = answerOf(
        "manager-2",
        true,
        "child-7:refund-agent:1:call-2",
        "2026-01-05T09:10:00.000Z",
      );
      await first.savePauseAnswer("acme", "root-1", early);
      await first.savePauseAnswer("acme", "root-1", late);

      await second.markPauseAnswerNotTaken("acme", "root-1", { ...early, isTaken: false });

      const entries = await first.findPauseAnswersByTenantIdAndRootExecutionId("acme", "root-1");
      expect(entries.map((entry) => entry.answeredBy)).toEqual(["manager-1", "manager-2"]);
      expect(entries.map((entry) => entry.isTaken)).toEqual([false, undefined]);
    },
  },
];

/** The pause answer log's cases (#676), for `executionRecordContract`. */
export const pauseAnswerCases = (): readonly ContractCase<ExecutionRecordRepository>[] => CASES;
