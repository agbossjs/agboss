import { beforeEach, describe, expect } from "vitest";
import { OutdatedReason } from "../../../src/index.js";
import { replyWith, testWith } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import { ItemDto } from "./fixtures/fan-out.workflow.js";
import { childLog, resetChildLog } from "./fixtures/children.workflow.js";
import {
  ItemPickerAgent,
  PickedWorkflowFinish,
  PickLoopApplication,
  PickLoopWorkflowStart,
} from "./fixtures/child-outdating.workflow.js";

/**
 * #271 AC12 (child part) — a child starts with its start input only, and its result is outdated
 * when the parent value given to its start is renewed; a child in a loop runs anew each pass.
 */

const test = testWith(PickLoopApplication);
const who = {
  tenant: { tenantId: "acme", plan: "pro" },
  execution: { userId: "u1" },
  record: true,
};

beforeEach(resetChildLog);

describe("#271 AC12: outdating across a child", () => {
  test("a renewed start input outdates the child's result", async ({ app, mockLlm }) => {
    mockLlm(ItemPickerAgent).thenReturn(
      replyWith(ItemDto, { name: "retry", delay: 0, outcome: "ok" }),
      replyWith(ItemDto, { name: "keeper", delay: 0, outcome: "ok" }),
    );

    const result = await execute(app, PickLoopWorkflowStart, { text: "pick" }, who);

    expect(result).toFinishWith(PickedWorkflowFinish, { name: "keeper" });
    const outdated = result.record?.outdatedValues ?? [];
    expect(outdated).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slot: "ItemResultDto",
          producer: "item-check-workflow",
          value: { name: "retry" },
          outdated: expect.objectContaining({ reason: OutdatedReason.BuiltFromReplaced }),
        }),
      ]),
    );
    const current = result.record?.scope.find((value) => value.slot === "ItemResultDto");
    expect(current?.builtFrom).toEqual(["item-picker-agent:2/ItemDto"]);
  });

  test("a child in a loop: a new execution each pass, its start input only", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ItemPickerAgent).thenReturn(
      replyWith(ItemDto, { name: "retry", delay: 0, outcome: "ok" }),
      replyWith(ItemDto, { name: "keeper", delay: 0, outcome: "ok" }),
    );

    const result = await execute(app, PickLoopWorkflowStart, { text: "pick" }, who);

    expect(result.children.map((child) => [child.launchedBy.visitNumber, child.input])).toEqual([
      [1, { name: "retry", delay: 0, outcome: "ok" }],
      [2, { name: "keeper", delay: 0, outcome: "ok" }],
    ]);
    const [first, second] = result.children;
    expect(first?.executionId).not.toBe(second?.executionId);
    expect(childLog.readings.map((reading) => reading.key)).toEqual([
      `${first?.executionId ?? ""}:check-item-action:1`,
      `${second?.executionId ?? ""}:check-item-action:1`,
    ]);
    // the child's own scope held its start input only: the parent's text never reached it
    expect(second?.path).toEqual([
      "item-check-workflow-start",
      "check-item-action",
      "item-checked-workflow-finish",
    ]);
  });
});
