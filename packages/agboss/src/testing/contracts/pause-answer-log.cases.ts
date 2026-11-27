import { expect } from "vitest";
import type { PauseAnswerRecord } from "../../flow/runtime/execution-record.js";
import { ComponentKind } from "../../flow/runtime/records.js";
import type { ExecutionRecordRepository } from "../../infrastructure/execution-record.repository.js";
import { PauseResolution } from "../../infrastructure/pause-record.js";
import type { ContractCase } from "./define.js";
import { PauseRespondent } from "../../pause/respondent.js";

/**
 * The pause answer log (#267 S107, #676): one answer per pause **of a tree** — a step key names no
 * tree (`<executionId>:<node>:<visit>[:<item>]:<callId>`), so two trees whose ids repeat (#663)
 * share one; each keeps its own answer, and a second save of one tree's pause is ignored.
 */

const STEP_KEY = "child-7:refund-agent:1:call-1";

/** The answer of the refund pause at `STEP_KEY`, by `responder` (as its actor), decided `approved`. */
export const answerOf = (
  responder: string,
  approved: boolean,
  key = STEP_KEY,
  askedAt = new Date("2026-01-05T09:00:00.000Z"),
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
  target: "refund-tool-approval",
  channel: "refund-approval-channel",
  respondent: PauseRespondent.Delegate,
  actor: { id: responder, orgId: "holding-hq" },
  resolution: PauseResolution.Replied,
  askedAt,
  resolvedAt: new Date("2026-01-05T09:05:00.000Z"),
  decision: { approved },
  input: { text: "10 USD" },
  toolCall: { callId: "call-1", tool: "charge", summary: "charge" },
  assignees: ["manager-17", "manager-18"],
  externalRef: "JIRA-17",
  trail: [
    {
      action: "opened",
      at: askedAt,
      target: "refund-tool-approval",
      channel: "refund-approval-channel",
    },
  ],
});

const respondersOf = async (
  records: ExecutionRecordRepository,
  rootExecutionId: string,
): Promise<readonly (string | undefined)[]> =>
  (await records.findPauseAnswersByTenantIdAndRootExecutionId("acme", rootExecutionId)).map(
    (answer) => answer.actor?.id,
  );

const CASES: readonly ContractCase<ExecutionRecordRepository>[] = [
  {
    name: "#1307: the times of an answer come back as Dates of the very instants written, milliseconds kept",
    run: async ({ first, second }) => {
      const askedAt = new Date("2026-01-05T09:00:00.123Z");
      const answer = {
        ...answerOf("manager-17", true, STEP_KEY, askedAt),
        resolvedAt: new Date("2026-01-05T09:05:00.456Z"),
      };
      await first.savePauseAnswer("acme", "root-1", answer);

      const [read] = await second.findPauseAnswersByTenantIdAndRootExecutionId("acme", "root-1");

      expect(read?.askedAt).toBeInstanceOf(Date);
      expect(read?.askedAt.getTime()).toBe(askedAt.getTime());
      expect(read?.resolvedAt).toBeInstanceOf(Date);
      expect(read?.resolvedAt?.getTime()).toBe(new Date("2026-01-05T09:05:00.456Z").getTime());
      expect(read?.trail[0]?.at).toBeInstanceOf(Date);
      expect(read?.trail[0]?.at.getTime()).toBe(askedAt.getTime());
    },
  },
  {
    name: "#1307: answers are listed in the order they were asked, by instant (not by a text spelling of it)",
    run: async ({ first, second }) => {
      // asked within one second, and across the year 2026's DST changes of a local zone
      const times = [
        "2026-03-29T00:30:00.900Z",
        "2026-03-29T00:30:00.100Z",
        "2026-10-25T00:30:00.000Z",
        "2026-10-25T01:30:00.000Z",
      ].map((text) => new Date(text));
      for (const [index, asked] of times.entries())
        await first.savePauseAnswer(
          "acme",
          "root-1",
          answerOf(`manager-${String(index)}`, true, `child-7:refund-agent:1:call-${String(index)}`, asked),
        );

      const read = await second.findPauseAnswersByTenantIdAndRootExecutionId("acme", "root-1");

      expect(read.map((entry) => entry.askedAt.getTime())).toEqual(
        times.map((asked) => asked.getTime()).sort((a, b) => a - b),
      );
    },
  },
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
