/**
 * #267 AC11: tests answer channels without people — a tool that names `AutoApproveChannel` runs at
 * once (its channel decides, nothing pauses), and a role's implementation is scripted with
 * `mockOf(Implementation).send` (`tests/channels/validation.test.ts`) or replaced in the
 * container with `testWith(App, { overrides: [override(Role, AutoApproveChannel)] })` (#267 S104).
 * Scripted reply interpreters come with #267 PR 3.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { AutoApproveChannel, PauseResolution, PauseStatus } from "../../src/index.js";
import {
  RefundApprovalChannel,
  RefundCardOutputDto,
  RefundCardTool,
  RefundClerkAgent,
  RefundWorkflowFinish,
  RefundWorkflowStart,
  SlackRefundsApplication,
} from "../flow/fixtures/refunds.fixture.js";
import { callTool, override, replyWith, testWith } from "../../src/testing/index.js";
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
    mockLlm,
  }) => {
    mockLlm(DeskClerkAgent).thenReturn(
      callTool(AutoRefundTool, { orderId: "7" }),
      replyWith("Refunded."),
    );

    const done = await execute(app, DeskWorkflowStart, { text: "refund 7" });

    expect(done).toFinishWith(DeskWorkflowFinish, { text: "Refunded." });
    expect(done.pending).toEqual([]);
    expect(seen.refunds).toEqual(["7"]);
    expect(seen.pauses).toEqual([]);
    const records = await pauseStore().findAllByTenantIdAndRootExecutionId("default", done.runId);
    expect(records).toMatchObject([
      { status: PauseStatus.Taken, resolution: PauseResolution.Decided },
    ]);
  });
});

/** A channel whose decision is not the role's answer DTO. */
class WrongDecisionChannel {
  send(): Promise<{ readonly kind: "decided"; readonly decision: { readonly approved: string } }> {
    return Promise.resolve({ kind: "decided", decision: { approved: "yes" } });
  }
}

class NoSendChannel {
  ask(): void {
    // not a channel: no send(…)
  }
}

const slack = testWith(SlackRefundsApplication, {
  overrides: [override(RefundApprovalChannel, AutoApproveChannel)],
});

describe("#267 S104: a role replaced by override(Role, AutoApproveChannel)", () => {
  slack(
    "the role's tool goes on at once with decided({ approved: true }): no pause",
    async ({ app, mockLlm }) => {
      mockLlm(RefundClerkAgent).thenReturn(
        callTool(RefundCardTool, { orderId: "8", amountCents: 900 }),
        replyWith(RefundCardOutputDto, { status: "refunded 8" }),
      );

      const done = await execute(app, RefundWorkflowStart, { text: "refund 8" });

      expect(done).toFinishWith(RefundWorkflowFinish, { status: "refunded 8" });
      expect(done.pending).toEqual([]);
    },
  );

  it("a replacement that does not fit the role does not compile", () => {
    // @ts-expect-error — its decision is not the role's ToolCallApprovalDecisionDto
    const wrong = override(RefundApprovalChannel, WrongDecisionChannel);
    // @ts-expect-error — a class without send(ask) is no channel of the role
    const noSend = override(RefundApprovalChannel, NoSendChannel);

    expect([wrong.replacement, noSend.replacement]).toEqual([WrongDecisionChannel, NoSendChannel]);
  });
});
