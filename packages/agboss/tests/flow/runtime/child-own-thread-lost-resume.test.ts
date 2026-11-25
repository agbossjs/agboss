/**
 * #1090 — an own-thread child (ADR-0022) cut off right after its input checkpoint: the child's
 * thread holds only its input (the hidden start task's writes and every checkpoint after them never
 * answer), its holder hands over. LangGraph leaves the hidden start task out of `next`, so an empty
 * `next` there does not say the child ended: the next holder runs the child from its input and the
 * tree finishes — never reads the child as ended with its defaults. (The child's answered question
 * in the same kind of window is #1098's `writes-window-pauses.test.ts`.)
 */
import { beforeEach, describe, expect } from "vitest";
import { ExecutionLeaseLostError } from "../../../src/index.js";
import { replyWith, testWith } from "../../../src/testing/index.js";
import { seconds } from "../../../src/units/index.js";
import { execute } from "../../helpers/flow.js";
import { passLive } from "../../helpers/live-time.js";
import { ends, resetRecovery, seen } from "../../infrastructure/fixtures/recovery.workflow.js";
import { instance, rejectionOf } from "../../app/fixtures/fence-takeover.js";
import { resetWindow, window } from "../../app/fixtures/writes-window.application.js";
import { ItemResultDto, type ItemDto } from "./fixtures/fan-out.workflow.js";
import {
  ItemReviewerAgent,
  resetChildLog,
  ReviewOneWorkflowStart,
} from "./fixtures/children.workflow.js";
import { ChildrenWindowApplication } from "./fixtures/children-window.application.js";

const test = testWith(ChildrenWindowApplication, { instances: 2 });
const who = { tenant: { tenantId: "acme", plan: "pro" }, execution: { userId: "u1" } };
const item: ItemDto = { name: "b", delay: 0, outcome: "ok" };

beforeEach(() => {
  resetWindow();
  resetChildLog();
  resetRecovery();
});

describe("#1090: an own-thread child cut off after its input checkpoint", () => {
  test("the child's thread holds only its input: the next holder runs the child from it, the tree finishes at its finish", async ({
    apps,
    clock,
    mockModel,
  }) => {
    mockModel(ItemReviewerAgent).thenReturn(replyWith(ItemResultDto, { name: "b" }));
    const [a, b] = [instance(apps, 0), instance(apps, 1)];
    await a.ready();
    await b.ready();
    window.hangChildStart = true;

    const failure = rejectionOf(execute(a, ReviewOneWorkflowStart, item, who));
    await passLive(clock, seconds(40));
    expect(await failure).toBeInstanceOf(ExecutionLeaseLostError);
    // the window: the child's hidden start task's writes were asked for and never saved
    expect(window.childStartHung).toBe(true);
    window.hangChildStart = false;
    await passLive(clock, seconds(60));
    const finished = (await ends(2)).map((end) => end.finish);

    expect(finished).toEqual(["item-reviewed-workflow-finish", "item-reviewed-workflow-finish"]);
    expect(seen.errors).toEqual([]);
  });
});
