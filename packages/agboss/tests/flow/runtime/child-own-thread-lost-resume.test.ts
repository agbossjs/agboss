/**
 * #1090 — (a sweep, not a proof of the window: the scenario that reaches it is #1098) an own-thread child resumed by an answer whose holder lost the tree after the child's
 * resumed task saved its writes and before the next checkpoint: the next holder continues the
 * child from its saved writes. It must not read the child's old interrupt as still open (the parent
 * would pause again with nothing to answer, for ever).
 */
import { beforeEach, describe, expect } from "vitest";
import { ExecutionLeaseLostError } from "../../../src/index.js";
import { callTool, replyWith, testWith, type ModelRequest } from "../../../src/testing/index.js";
import { seconds } from "../../../src/units/index.js";
import { execute } from "../../helpers/flow.js";
import { passLive } from "../../helpers/live-time.js";
import { ends, resetRecovery, seen } from "../../infrastructure/fixtures/recovery.workflow.js";
import { rejectionOf } from "../../app/fixtures/fence-takeover.js";
import { resetWindow, window } from "../../app/fixtures/writes-window.application.js";
import { ItemResultDto, type ItemDto } from "./fixtures/fan-out.workflow.js";
import {
  ConfirmReviewTool,
  ItemReviewerAgent,
  resetChildLog,
  ReviewOneWorkflowStart,
} from "./fixtures/children.workflow.js";
import { ChildrenWindowApplication } from "./fixtures/children-window.application.js";

const test = testWith(ChildrenWindowApplication, { instances: 2 });
const who = { tenant: { tenantId: "acme", plan: "pro" }, execution: { userId: "u1" } };
const item: ItemDto = { name: "b", delay: 0, outcome: "ok" };

const reviewer = (request: ModelRequest) => {
  const confirmed =
    request.kind === "chat" && request.messages.some((line) => line.role === "tool");
  return confirmed
    ? replyWith(ItemResultDto, { name: "b" })
    : callTool(ConfirmReviewTool, { name: "b" });
};

beforeEach(() => {
  resetWindow();
  resetChildLog();
  resetRecovery();
});

describe("#1090: an own-thread child resumed, its holder lost before the next checkpoint", () => {
  for (const after of [0]) {
    test(`the child's checkpoint after its resumed step's writes never answers: the next holder finishes the tree`, async ({
      apps,
      clock,
      mockLlm,
    }) => {
      mockLlm(ItemReviewerAgent).thenAnswer(reviewer);
      const [a, b] = apps;
      await a?.ready();
      await b?.ready();
      const paused = await execute(a!, ReviewOneWorkflowStart, item, who);
      const answer = { pauseId: paused.pending[0]?.pauseId ?? "", decision: { approved: true } };
      window.hangChildPut = true;

      const failure = rejectionOf(a!.resume(answer, { tenantId: "acme" }));
      await passLive(clock, seconds(40));
      expect(await failure).toBeInstanceOf(ExecutionLeaseLostError);
      window.hangChildPut = false;
      await passLive(clock, seconds(60));
      const [end] = await ends(1);

      expect(end).toBeDefined();
      expect(seen.errors).toEqual([]);
    });
  }
});
