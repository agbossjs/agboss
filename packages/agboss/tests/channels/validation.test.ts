/**
 * #267 AC7: a decision is validated on the way in — on `app.resume` (a `ToolCallApprovalDecisionDto`,
 * `overrideArguments` only with `approved: true` and a valid input of the tool), the pause staying
 * pending when it is refused. On `ChannelOutcome.decided(…)`: `tests/channels/channel-outcome.test.ts`.
 */
import { beforeEach, describe, expect } from "vitest";
import { DtoValidationError } from "../../src/dto/index.js";
import { PauseStatus } from "../../src/index.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import {
  DeskClerkAgent,
  DeskWorkflowStart,
  pauseStore,
  PausesApplication,
  RefundTool,
  resetPauses,
  seen,
} from "./fixtures/pauses.workflow.js";
import { answerFor, askFor, manager } from "./fixtures/pause-scripts.js";

const test = testWith(PausesApplication);

beforeEach(resetPauses);

/** The desk's pause about order 7, as stored. */
const pauseOf7 = () => pauseStore().findByTenantIdAndPauseId("default", askFor("7").pauseId);

describe("#267 AC7: app.resume validates the decision before it records it", () => {
  test.for([
    [
      "overrideArguments with approved: false",
      { approved: false, overrideArguments: { orderId: "8" } },
    ],
    [
      "overrideArguments the tool does not take",
      { approved: true, overrideArguments: { orderId: 8 } },
    ],
    ["no approved at all", { approve: true }],
  ] as const)("%s is refused: the pause stays pending", async ([, decision], { app, mockLlm }) => {
    mockLlm(DeskClerkAgent).thenReturn(callTool(RefundTool, { orderId: "7" }), replyWith("Done."));
    await execute(app, DeskWorkflowStart, { text: "refund 7" });

    const refused = app.resume(answerFor("7", decision), manager);

    await expect(refused).rejects.toBeInstanceOf(DtoValidationError);
    expect((await pauseOf7())?.status).toBe(PauseStatus.Pending);
    await app.resume(answerFor("7"), manager);
    expect(seen.refunds).toEqual(["7"]);
  });

  test("approved with overrideArguments: the tool runs with them", async ({ app, mockLlm }) => {
    mockLlm(DeskClerkAgent).thenReturn(callTool(RefundTool, { orderId: "7" }), replyWith("Done."));
    await execute(app, DeskWorkflowStart, { text: "refund 7" });

    await app.resume(
      answerFor("7", { approved: true, overrideArguments: { orderId: "8" } }),
      manager,
    );

    expect(seen.refunds).toEqual(["8"]);
  });
});
