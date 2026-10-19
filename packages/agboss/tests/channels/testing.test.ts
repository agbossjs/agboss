/**
 * #267 AC11: tests answer channels without people — a tool that names `AutoApproveChannel` runs at
 * once (its channel decides, nothing pauses), and a role's implementation is scripted with
 * `mockOf(Implementation).send` (`tests/channels/validation.test.ts`). Scripted reply interpreters
 * come with #267 PR 3.
 */
import { beforeEach, describe, expect } from "vitest";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import {
  AutoRefundTool,
  DeskClerkAgent,
  DeskWorkflowFinish,
  DeskWorkflowStart,
  pauseStore,
  PausesApplication,
  resetPauses,
  seen,
} from "./fixtures/pauses.workflow.js";

const test = testWith(PausesApplication);

beforeEach(resetPauses);

describe("#267 AC11: AutoApproveChannel decides at once", () => {
  test("the tool runs with no pause and no pause record", async ({ app, mockLlm }) => {
    mockLlm(DeskClerkAgent).thenReturn(
      callTool(AutoRefundTool, { orderId: "7" }),
      replyWith("Refunded."),
    );

    const done = await execute(app, DeskWorkflowStart, { text: "refund 7" });

    expect(done).toFinishWith(DeskWorkflowFinish, { text: "Refunded." });
    expect(done.pending).toEqual([]);
    expect(seen.refunds).toEqual(["7"]);
    expect(seen.pauses).toEqual([]);
    expect(await pauseStore().findAllByTenantIdAndRootExecutionId("default", done.runId)).toEqual(
      [],
    );
  });
});
