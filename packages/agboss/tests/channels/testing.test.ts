/**
 * #267 AC11: tests answer channels without people — a tool that names `AutoApproveChannel` runs at
 * once (its channel decides, nothing pauses), and a role's implementation is scripted with
 * `mockService(Implementation).send` (`tests/channels/validation.test.ts`) or replaced in the
 * container with `testWith(App, { services: [AutoApproveChannel.for(Role)] })` (#267 S104).
 * Scripted reply interpreters come with #267 PR 3.
 */
import { beforeEach, describe, expect } from "vitest";
import { PauseResolution, PauseStatus } from "../../src/index.js";
import { AutoApproveChannel } from "../../src/testing/index.js";
import {
  RefundDeskToolApproval,
  RefundCardOutputDto,
  RefundCardTool,
  RefundClerkAgent,
  RefundWorkflowFinish,
  RefundWorkflowStart,
  SlackRefundsApplication,
} from "../flow/fixtures/refunds.fixture.js";
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
  test("the tool runs with no pause: its record is closed as Decided at once", async ({
    app,
    mockModel,
  }) => {
    mockModel(DeskClerkAgent).thenReturn(
      callTool(AutoRefundTool, { orderId: "7" }),
      replyWith("Refunded."),
    );

    const done = await execute(app, DeskWorkflowStart, { text: "refund 7" });

    expect(done).toFinishWith(DeskWorkflowFinish, { text: "Refunded." });
    expect(done.pending).toEqual([]);
    expect(seen.refunds).toEqual(["7"]);
    expect(seen.pauses).toEqual([]);
    const records = await pauseStore().findAllByTenantIdAndRootExecutionId(
      "default",
      done.executionId,
    );
    expect(records).toMatchObject([
      { status: PauseStatus.Taken, resolution: PauseResolution.Decided },
    ]);
  });
});

const slack = testWith(SlackRefundsApplication, {
  services: [AutoApproveChannel.for(RefundDeskToolApproval)],
});

describe("#267 S104: a role replaced by AutoApproveChannel.for(Role)", () => {
  slack(
    "the role's tool goes on at once with decided({ approved: true }): no pause",
    async ({ app, mockModel }) => {
      mockModel(RefundClerkAgent).thenReturn(
        callTool(RefundCardTool, { orderId: "8", amountCents: 900 }),
        replyWith(RefundCardOutputDto, { status: "refunded 8" }),
      );

      const done = await execute(app, RefundWorkflowStart, { text: "refund 8" });

      expect(done).toFinishWith(RefundWorkflowFinish, { status: "refunded 8" });
      expect(done.pending).toEqual([]);
    },
  );
});
