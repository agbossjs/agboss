import { expect } from "vitest";
import type { ExecutionRecordRepository } from "../../infrastructure/execution-record.repository.js";
import type { ContractCase } from "./define.js";
import { answerOf } from "./pause-answer-data.js";

export { answerOf };

/**
 * The pause answer log (#267 S107, #676): one answer per pause **of a tree** — a step key names no
 * tree (`<executionId>:<node>:<visit>[:<item>]:<callId>`), so two trees whose ids repeat (#663)
 * share one; each keeps its own answer, and a second save of one tree's pause is ignored.
 */

const respondersOf = async (
  records: ExecutionRecordRepository,
  rootExecutionId: string,
): Promise<readonly (string | undefined)[]> =>
  (await records.findPauseAnswersByTenantIdAndRootExecutionId("acme", rootExecutionId)).map(
    (answer) => answer.actor?.id,
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
        actor: { id: "manager-17", orgId: "holding-hq" },
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
        actor: { id: "manager-17", orgId: "holding-hq" },
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
        expect(entries[0]).toMatchObject({
          isTaken: false,
          actor: { id: "manager-17", orgId: "holding-hq" },
        });
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
        new Date("2026-01-05T09:00:00.000Z"),
      );
      const late = answerOf(
        "manager-2",
        true,
        "child-7:refund-agent:1:call-2",
        new Date("2026-01-05T09:10:00.000Z"),
      );
      await first.savePauseAnswer("acme", "root-1", early);
      await first.savePauseAnswer("acme", "root-1", late);

      await second.markPauseAnswerNotTaken("acme", "root-1", { ...early, isTaken: false });

      const entries = await first.findPauseAnswersByTenantIdAndRootExecutionId("acme", "root-1");
      expect(entries.map((entry) => entry.actor?.id)).toEqual(["manager-1", "manager-2"]);
      expect(entries.map((entry) => entry.isTaken)).toEqual([false, undefined]);
    },
  },
];

/** The pause answer log's cases (#676), for `executionRecordContract`. */
export const pauseAnswerCases = (): readonly ContractCase<ExecutionRecordRepository>[] => CASES;
