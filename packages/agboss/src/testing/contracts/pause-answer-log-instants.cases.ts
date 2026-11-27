import { expect } from "vitest";
import { StoreErrorKind } from "../../core/error-families/store-errors.js";
import type { ExecutionRecordRepository } from "../../infrastructure/execution-record.repository.js";
import type { ContractCase } from "./define.js";
import { answerOf, STEP_KEY } from "./pause-answer-data.js";

/** #1307 (G3): the times of the answer log are `Date`s of the very instant, listed in the order of the instants. */
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
          answerOf(
            `manager-${String(index)}`,
            true,
            `child-7:refund-agent:1:call-${String(index)}`,
            asked,
          ),
        );

      const read = await second.findPauseAnswersByTenantIdAndRootExecutionId("acme", "root-1");

      expect(read.map((entry) => entry.askedAt.getTime())).toEqual(
        times.map((asked) => asked.getTime()).sort((a, b) => a - b),
      );
    },
  },
  {
    name: "#1307: an answer with an Invalid Date in any of its times is refused with StoreError.UnreadableRecord, and nothing is written",
    run: async ({ first, second }) => {
      const good = answerOf("manager-17", true, STEP_KEY, new Date("2026-01-05T09:00:00.123Z"));
      const invalid = (): Date => new Date(Number.NaN);
      const variants = {
        askedAt: { ...good, askedAt: invalid() },
        resolvedAt: { ...good, resolvedAt: invalid() },
        "trail[0].at": { ...good, trail: [{ ...good.trail[0], at: invalid() }] },
      } as Record<string, typeof good>;

      for (const [field, answer] of Object.entries(variants)) {
        for (const save of [
          () => first.savePauseAnswer("acme", "root-1", answer),
          () => first.markPauseAnswerNotTaken("acme", "root-1", answer),
        ]) {
          const error = await save().then(
            () => undefined,
            (caught: unknown) => caught,
          );
          expect(error, field).toMatchObject({ kind: StoreErrorKind.UnreadableRecord });
        }
      }

      expect(await second.findPauseAnswersByTenantIdAndRootExecutionId("acme", "root-1")).toEqual(
        [],
      );
    },
  },
];

/** The pause answer log's cases for instants, for `executionRecordContract`. */
export const pauseAnswerInstantCases = (): readonly ContractCase<ExecutionRecordRepository>[] =>
  CASES;
