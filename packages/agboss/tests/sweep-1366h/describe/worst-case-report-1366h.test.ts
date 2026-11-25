/**
 * #1366: the worst-case report of a start, built from a worst case by hand: the widest child edge is the one the
 * at-the-same-time number is made of (the first of equals), what bounds an edge (maxConcurrency below the count, else
 * maxItems), the deepest chain, the maxDepth of a recursive chain, the cap of the tree's executions at work, and the
 * rows aligned on their widest number.
 */
import { describe, expect, it } from "vitest";
import {
  worstCaseReportLines,
  worstCaseRowsOf,
  WorstCaseMeasure,
  type WorstCaseLimits,
} from "../../../src/describe/worst-case-report.js";
import type { WorstCase, WorstCaseChild } from "../../../src/flow/analyse/worst-case.js";

const worstOf = (workflow: string, more: Partial<WorstCase> = {}): WorstCase => ({
  start: `${workflow}-start` as never,
  workflow,
  executions: 1,
  concurrentExecutions: 1,
  steps: 1,
  isStepsCapped: false,
  treeSteps: 1,
  depth: 0,
  parts: [],
  children: [],
  ...more,
});

const childOf = (
  worst: WorstCase,
  more: Partial<WorstCaseChild> & { readonly count?: number } = {},
): WorstCaseChild => ({
  from: "launcher",
  count: 1,
  atOnce: 1,
  isRecursive: false,
  worst,
  ...more,
});

const NO_CAP: WorstCaseLimits = { maxConcurrency: 1000 };

const rowOf = (worst: WorstCase, measure: WorstCaseMeasure, limits = NO_CAP) =>
  worstCaseRowsOf(worst, limits).find((row) => row.measure === measure);

describe("#1366: the at-the-same-time row follows the widest child edge", () => {
  it("takes the edge with the most at once (at once times the child's own), the first of equals", () => {
    const children = [
      childOf(worstOf("w-a", { concurrentExecutions: 1 }), { count: 2, atOnce: 2 }),
      childOf(worstOf("w-b", { concurrentExecutions: 4 }), { count: 1, atOnce: 1 }),
      childOf(worstOf("w-c", { concurrentExecutions: 4 }), { count: 1, atOnce: 1 }),
      childOf(worstOf("w-d", { concurrentExecutions: 1 }), { count: 1, atOnce: 1 }),
    ];
    const worst = worstOf("root", { children, concurrentExecutions: 5, executions: 6 });

    expect(rowOf(worst, WorstCaseMeasure.ConcurrentExecutions)).toEqual({
      measure: WorstCaseMeasure.ConcurrentExecutions,
      total: 5,
      madeUp: "1 root + 1 w-b",
    });
  });

  it("a single child edge is that edge, a call without children is itself", () => {
    const only = worstOf("root", {
      children: [childOf(worstOf("w-a"), { count: 3, atOnce: 3, maxItems: 3 })],
    });

    expect(rowOf(only, WorstCaseMeasure.ConcurrentExecutions)?.madeUp).toBe(
      "1 root + 3 w-a (maxItems 3)",
    );
    expect(rowOf(worstOf("root"), WorstCaseMeasure.ConcurrentExecutions)?.madeUp).toBe("1 root");
  });
});

describe("#1366: what bounds an edge", () => {
  const edgeRow = (more: Partial<WorstCaseChild>) =>
    rowOf(
      worstOf("root", { children: [childOf(worstOf("w-a"), { count: 3, atOnce: 3, ...more })] }),
      WorstCaseMeasure.ConcurrentExecutions,
    )?.madeUp;
  const countRow = (more: Partial<WorstCaseChild>) =>
    rowOf(
      worstOf("root", { children: [childOf(worstOf("w-a"), { count: 3, atOnce: 3, ...more })] }),
      WorstCaseMeasure.Executions,
    )?.madeUp;

  it("maxConcurrency below the count bounds the at-once number", () => {
    expect(edgeRow({ maxItems: 3, maxConcurrency: 2, atOnce: 2 })).toBe(
      "1 root + 2 w-a (maxConcurrency 2)",
    );
  });

  it("maxConcurrency equal to the count or above it does not: maxItems does", () => {
    expect(edgeRow({ maxItems: 3, maxConcurrency: 3 })).toBe("1 root + 3 w-a (maxItems 3)");
    expect(edgeRow({ maxItems: 3, maxConcurrency: 7 })).toBe("1 root + 3 w-a (maxItems 3)");
  });

  it("without maxConcurrency maxItems bounds it, and one child has no bound at all", () => {
    expect(edgeRow({ maxItems: 3 })).toBe("1 root + 3 w-a (maxItems 3)");
    expect(edgeRow({})).toBe("1 root + 3 w-a");
  });

  it("the executions row names maxItems only, whatever maxConcurrency says", () => {
    expect(countRow({ maxItems: 3, maxConcurrency: 2, atOnce: 2 })).toBe(
      "1 root + 3 w-a (maxItems 3)",
    );
    expect(countRow({})).toBe("1 root + 3 w-a");
  });
});

describe("#1366: the nesting depth row", () => {
  it("follows the child whose own depth makes the call's depth, not the first child", () => {
    const deep = worstOf("deep", {
      depth: 1,
      children: [childOf(worstOf("leaf"))],
    });
    const worst = worstOf("root", {
      depth: 2,
      children: [childOf(worstOf("shallow")), childOf(deep)],
    });

    expect(rowOf(worst, WorstCaseMeasure.Depth)).toEqual({
      measure: WorstCaseMeasure.Depth,
      total: 3,
      madeUp: "root → deep → leaf",
    });
  });

  it("adds maxDepth when one level of the chain is the workflow again, and has it", () => {
    const again = worstOf("loop", {
      depth: 1,
      children: [childOf(worstOf("loop"), { isRecursive: true })],
    });
    const worst = worstOf("root", { depth: 2, children: [childOf(again)] });

    expect(rowOf(worst, WorstCaseMeasure.Depth, { maxConcurrency: 9, maxDepth: 3 })?.madeUp).toBe(
      "root → loop → loop (maxDepth 3)",
    );
  });

  it("says nothing of maxDepth without one, or when no level of the chain is the workflow again", () => {
    const again = worstOf("loop", {
      depth: 1,
      children: [childOf(worstOf("loop"), { isRecursive: true })],
    });
    const recursive = worstOf("root", { depth: 2, children: [childOf(again)] });
    const plain = worstOf("root", {
      depth: 1,
      children: [childOf(worstOf("kid"))],
    });

    expect(rowOf(recursive, WorstCaseMeasure.Depth)?.madeUp).toBe("root → loop → loop");
    expect(rowOf(plain, WorstCaseMeasure.Depth, { maxConcurrency: 9, maxDepth: 3 })?.madeUp).toBe(
      "root → kid",
    );
  });
});

describe("#1366: the steps row", () => {
  it("names the bound of each workflow's steps: maxSteps when capped, else the longest path", () => {
    const worst = worstOf("root", {
      steps: 12,
      isStepsCapped: true,
      treeSteps: 62,
      executions: 6,
      children: [
        childOf(worstOf("kid", { steps: 10, isStepsCapped: false }), { count: 5, atOnce: 5 }),
      ],
    });

    expect(rowOf(worst, WorstCaseMeasure.Steps)).toEqual({
      measure: WorstCaseMeasure.Steps,
      total: 62,
      madeUp: "12 in root (maxSteps) + 5 × 10 in kid (longest path)",
    });
  });
});

describe("#1366: the cap of the tree's executions at work", () => {
  const tree = (concurrent: number) =>
    worstOf("root", {
      concurrentExecutions: concurrent,
      children: [childOf(worstOf("kid"), { count: 4, atOnce: 4 })],
    });
  const atWork = (worst: WorstCase, maxConcurrency: number) =>
    rowOf(worst, WorstCaseMeasure.ConcurrentExecutions, { maxConcurrency })?.madeUp;

  it("adds the cap when it is lower than the tree's executions at once", () => {
    expect(atWork(tree(5), 4)).toBe(
      "1 root + 4 kid — at most 4 at work at once (maxConcurrency 4)",
    );
  });

  it("adds nothing when the cap equals them or is higher", () => {
    expect(atWork(tree(5), 5)).toBe("1 root + 4 kid");
    expect(atWork(tree(5), 6)).toBe("1 root + 4 kid");
  });

  it("adds nothing to a call without children", () => {
    expect(atWork(worstOf("root", { concurrentExecutions: 3 }), 2)).toBe("1 root");
  });
});

describe("#1366: the aligned report", () => {
  it("pads every number to the widest one and the measures to the widest measure", () => {
    const worst = worstOf("root", {
      executions: 156,
      concurrentExecutions: 40,
      treeSteps: 7,
      depth: 3,
    });

    expect(worstCaseReportLines(worst, NO_CAP)).toEqual([
      "Worst case of one root-start call",
      "  workflow executions  156  1 root",
      "  at the same time     40   1 root",
      "  steps                7    1 in root (longest path)",
      "  nesting depth        4    root",
    ]);
  });
});
