import { beforeEach, describe, expect } from "vitest";
import { BranchStatus } from "../../../src/index.js";
import { testWith, TestConcurrency } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import {
  fanOut,
  ItemsFailedWorkflowFinish,
  ItemsWorkflowStart,
  resetFanOut,
  SummaryWorkflowFinish,
  type ItemDto,
} from "./fixtures/fan-out.workflow.js";
import { MaxItemsApplication, TakeFirstApplication } from "./fixtures/for-each-item.workflow.js";

/** #1280: takeFirst slices and says so, maxItems is a limit before any branch, maxConcurrency holds. */

const REAL = { concurrency: TestConcurrency.Real };
const takeFirst = testWith(TakeFirstApplication, REAL);
const maxItems = testWith(MaxItemsApplication, REAL);

const ok = (name: string, delay = 0): ItemDto => ({ name, delay, outcome: "ok" });
const bad = (name: string): ItemDto => ({ name, delay: 0, outcome: "fail" });

beforeEach(resetFanOut);

describe("#1280: .forEachItem(step, { takeFirst })", () => {
  takeFirst(
    "launches exactly the first N, in list order, and reports the rest dropped",
    async ({ app }) => {
      const result = await execute(app, ItemsWorkflowStart, [
        ok("a"),
        ok("b"),
        ok("c"),
        ok("d"),
        ok("e"),
      ]);

      expect(result).toFinishWith(SummaryWorkflowFinish, { text: "a, b, c" });
      expect(result.launches[0]).toMatchObject({ items: 5, taken: 3 });
      expect(fanOut.events.filter((event) => event.startsWith("start "))).toHaveLength(3);
      expect(fanOut.truncated).toMatchObject([{ items: 5, takeFirst: 3 }]);
    },
  );

  takeFirst("a list of at most N is not truncated", async ({ app }) => {
    const result = await execute(app, ItemsWorkflowStart, [ok("a"), ok("b")]);

    expect(result).toFinishWith(SummaryWorkflowFinish, { text: "a, b" });
    expect(fanOut.truncated).toEqual([]);
  });

  takeFirst("maxConcurrency holds: never more than two at once", async ({ app }) => {
    await execute(app, ItemsWorkflowStart, [ok("a", 20), ok("b", 20), ok("c", 20), ok("d", 20)]);

    expect(fanOut.mostInFlight).toBe(2);
  });

  takeFirst("a failed item is skipped by .onError(E, skip())", async ({ app }) => {
    const result = await execute(app, ItemsWorkflowStart, [ok("a"), bad("b"), ok("c"), ok("d")]);

    expect(result).toFinishWith(SummaryWorkflowFinish, { text: "a, c" });
    expect(result.launches[0]?.branches.map((branch) => branch.status)).toEqual([
      BranchStatus.Finished,
      BranchStatus.Skipped,
      BranchStatus.Finished,
    ]);
  });
});

describe("#1280: .forEachItem(step, { maxItems })", () => {
  maxItems("a list within the limit runs every item", async ({ app }) => {
    const result = await execute(app, ItemsWorkflowStart, [ok("a"), ok("b"), ok("c")]);

    expect(result).toFinishWith(SummaryWorkflowFinish, { text: "a, b, c" });
    expect(fanOut.truncated).toEqual([]);
  });

  maxItems(
    "a longer list launches no branch: LimitError.Items takes the join's handler, the producer's list is on the path",
    async ({ app }) => {
      const result = await execute(app, ItemsWorkflowStart, [ok("a"), ok("b"), ok("c"), ok("d")], {
        record: true,
      });

      expect(result).toFinishWith(ItemsFailedWorkflowFinish, { text: "failed on one of 4" });
      expect(fanOut.events).toEqual([]);
      expect(result.launches).toEqual([]);
      expect(result.record?.lastError).toMatchObject({
        code: "limit.items",
        details: { limit: 3, actual: 4 },
      });
      expect(fanOut.truncated).toEqual([]);
    },
  );
});
