import { beforeEach, describe, expect } from "vitest";
import { testWith } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import type { ItemDto } from "./fixtures/fan-out.workflow.js";
import {
  CheckItemsWorkflowStart,
  CheckOneWorkflowStart,
  CheckOrFallbackWorkflowStart,
  ChecksSummaryWorkflowFinish,
  ChildrenApplication,
  childLog,
  DeepCheckItemsWorkflowStart,
  resetChildLog,
  type ChildReading,
} from "./fixtures/children.workflow.js";

/**
 * #263 PR 2 — a child in its tree: AC14 (its own id, inherited owner / tenant / project fields),
 * AC20 (`itemIndex`, `executionOf(W)` from any depth), #261 S72 h (contexts inherited through the
 * state), the events' `parentExecutionId` / `rootExecutionId`.
 */

const test = testWith(ChildrenApplication);
const who = {
  tenant: { tenantId: "acme", plan: "pro" },
  execution: { userId: "u1" },
  ownerId: "dana",
};
const item = (name: string): ItemDto => ({ name, delay: 0, outcome: "ok" });

const byItem = (readings: readonly ChildReading[]): readonly ChildReading[] =>
  [...readings].sort((first, second) => first.item.localeCompare(second.item));

beforeEach(resetChildLog);

describe("AC20: itemIndex per item, undefined for single and root", () => {
  test("itemIndex per item, undefined for single and root, executionOf(W)", async ({ app }) => {
    const result = await execute(app, CheckItemsWorkflowStart, [item("a"), item("b")], who);

    expect(byItem(childLog.readings)).toMatchObject([
      { item: "a", itemIndex: 0, checksItemIndex: 0, depth: 2, parentStep: "item-check-workflow" },
      { item: "b", itemIndex: 1, checksItemIndex: 1, depth: 2, parentStep: "item-check-workflow" },
    ]);
    const records = [...result.children].sort((x, y) => (x.itemIndex ?? 0) - (y.itemIndex ?? 0));
    expect(records.map((child) => child.itemIndex)).toEqual([0, 1]);
    for (const [index, reading] of byItem(childLog.readings).entries())
      expect(reading.executionId).toBe(records[index]?.executionId);
  });

  test("a root has no itemIndex, no parent, and is its own root", async ({ app }) => {
    const result = await execute(app, CheckOrFallbackWorkflowStart, item("a"), who);

    expect(childLog.readings).toMatchObject([
      {
        itemIndex: undefined,
        depth: 1,
        parentExecutionId: undefined,
        parentStep: undefined,
        executionId: result.runId,
        rootExecutionId: result.runId,
        checksItemIndex: undefined,
      },
    ]);
  });

  test("a single child has no itemIndex", async ({ app }) => {
    await execute(app, CheckOneWorkflowStart, item("a"), who);

    expect(childLog.readings).toMatchObject([{ item: "a", itemIndex: undefined, depth: 2 }]);
  });

  test("inside a grandchild, executionOf(W) reads the ancestor's item from any depth", async ({
    app,
  }) => {
    const result = await execute(app, DeepCheckItemsWorkflowStart, [item("a"), item("b")], who);

    expect(result).toFinishWith(ChecksSummaryWorkflowFinish, { text: "a, b" });
    expect(byItem(childLog.readings)).toMatchObject([
      { item: "a", itemIndex: undefined, deepItemIndex: 0, depth: 3 },
      { item: "b", itemIndex: undefined, deepItemIndex: 1, depth: 3 },
    ]);
    for (const reading of childLog.readings) {
      expect(reading.rootExecutionId).toBe(result.runId);
      expect(reading.rootWorkflow).toBe("deep-check-items-workflow");
      expect(reading.parentExecutionId).not.toBe(result.runId);
    }
    expect(result.children.map((child) => child.children.length)).toEqual([1, 1]);
    expect(result.children[0]?.children[0]).toMatchObject({
      workflow: { name: "item-check-workflow" },
      parentExecutionId: result.children[0]?.executionId,
      rootExecutionId: result.runId,
    });
  });
});

describe("AC14: identity and inheritance", () => {
  test("own executionId; inherits ownerId, thread, tenant and project fields", async ({ app }) => {
    const result = await execute(app, CheckOneWorkflowStart, item("a"), who);

    const [reading] = childLog.readings;
    expect(reading).toMatchObject({
      parentExecutionId: result.runId,
      rootExecutionId: result.runId,
      tenantId: "acme",
      plan: "pro",
      userId: "u1",
      threadId: result.threadId,
    });
    expect(reading?.executionId).not.toBe(result.runId);
    expect(reading?.key).toBe(`${reading?.executionId ?? ""}:check-item-action:1`);
  });

  test("the child's events name its parent and its root", async ({ app }) => {
    const result = await execute(app, CheckOneWorkflowStart, item("a"), who);

    const child = result.children[0];
    expect(childLog.starts.map((event) => event.workflow.name)).toEqual([
      "check-one-workflow",
      "item-check-workflow",
    ]);
    expect(childLog.starts[1]).toMatchObject({
      executionId: child?.executionId,
      parentExecutionId: result.runId,
      rootExecutionId: result.runId,
      threadId: result.threadId,
      tenantId: "acme",
    });
    expect(childLog.ends.map((event) => event.workflow.name)).toEqual([
      "item-check-workflow",
      "check-one-workflow",
    ]);
    expect(childLog.ends[0]).toMatchObject({
      finish: { name: "item-checked-workflow-finish" },
      spend: { totalUsd: 0.01 },
    });
  });
});
