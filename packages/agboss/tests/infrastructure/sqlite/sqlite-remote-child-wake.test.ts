/**
 * #917 AC1 on SQLite — the parent of an `AnyInstance` child is woken by the child's completion on
 * two instances over one file: the child's lease cleanup held, the clock never advanced.
 */
import { describe, expect } from "vitest";
import { TestConcurrency, testWith } from "../../../src/testing/index.js";
import { holdChildRetires } from "../../app/fixtures/hold-child-retires.js";
import {
  resetYield,
  YieldOneWorkflowFinish,
  YieldOneWorkflowStart,
  yieldSeen,
} from "../../app/fixtures/remote-child-yield.workflow.js";
import { execute } from "../../helpers/flow.js";
import { until } from "../../helpers/until.js";
import { RemoteWakeSqliteApplication } from "./fixtures/remote-wake.application.js";
import { sqliteFilePerTest } from "./fixtures/sqlite.workflow.js";

sqliteFilePerTest();
const test = testWith(RemoteWakeSqliteApplication, {
  instances: 2,
  concurrency: TestConcurrency.Real,
});

const isRootStart = (line: string): boolean => line.startsWith("yield-one-workflow ");

describe("#917 AC1: SQLite", () => {
  test("AC1: the child completes, its lease cleanup is held, the clock never advances — the parent finishes, the child's end first", async ({
    apps,
  }) => {
    resetYield();
    const [a, b] = apps;
    if (a === undefined || b === undefined) throw new Error("two instances");
    await b.ready();
    await a.ready();
    const rootOf = (): string | undefined => yieldSeen.starts.find(isRootStart)?.split(" ")[1];
    const hold = holdChildRetires(apps, rootOf);
    const call = execute(a, YieldOneWorkflowStart, { name: "quick", delay: 0, outcome: "ok" });
    await until(() => hold.held.length === 1, "the child's retire held");

    const done = await Promise.race([
      call,
      new Promise<"hung">((resolve) => {
        setTimeout(() => {
          resolve("hung");
        }, 3000);
      }),
    ]);
    hold.release();

    expect(done).not.toBe("hung");
    expect(done).toFinishWith(YieldOneWorkflowFinish, { name: "quick" });
    expect(yieldSeen.ends).toHaveLength(2);
    expect(yieldSeen.ends.at(-1)).toBe(`yield-one-workflow ${rootOf() ?? ""}`);
  });
});
