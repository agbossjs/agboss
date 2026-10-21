import { afterEach, describe, expect, vi } from "vitest";
import { ExecutionStatus, NotPausedError, type ExecutionOutput } from "agboss";
import { callTool, replyWith, TestConcurrency, testWith } from "agboss/testing";
import { FlightBuyerAgent } from "../src/approvals/agents/flight-buyer.agent.js";
import { VenueBuyerAgent } from "../src/approvals/agents/venue-buyer.agent.js";
import { FlightBookingDto } from "../src/approvals/dtos/flight-booking.dto.js";
import { VenueBookingDto } from "../src/approvals/dtos/venue-booking.dto.js";
import { ApprovalTerminal } from "../src/approvals/services/approval-terminal.service.js";
import { PlacePurchaseTool } from "../src/approvals/tools/place-purchase.tool.js";
import { OffsiteBookingWorkflowFinish } from "../src/approvals/workflow-finishes/offsite-booking.workflow-finish.js";
import { OffsiteBookingWorkflowStart } from "../src/approvals/workflow-starts/offsite-booking.workflow-start.js";
import { FlowPatternsApplication } from "../src/flow-patterns.application.js";

/** Two approvals at once (#267, #346 AC2): two buyers side by side, each purchase a pause. */

const test = testWith(FlowPatternsApplication);
const realTest = testWith(FlowPatternsApplication, { concurrency: TestConcurrency.Real });

const OWNER = { ownerId: "offsite-organiser" };
const REQUEST = { text: "Offsite: Lakeside Lodge for $1800, flights TLV → LIS for $2400" };
const VENUE = { item: "Lakeside Lodge", amountUsd: 1800 };
const FLIGHTS = { item: "flights TLV → LIS", amountUsd: 2400 };
const APPROVE = { approved: true };
const DECLINE = { approved: false, reason: "too expensive" };

/** The id of the pause the agent's purchase waits in (a thread owner's pause lists it). */
function pauseIdOf(result: ExecutionOutput, agent: string): string {
  const pauseId = result.pending.find((pause) => pause.agent === agent)?.pauseId;
  if (pauseId === undefined) throw new Error(`no pause of ${agent} is pending`);
  return pauseId;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("two purchases wait for the thread's owner at once", () => {
  test("both pauses are pending, each question asked once", async ({ app, mockLlm, mockOf }) => {
    const terminal = mockOf(ApprovalTerminal);
    mockLlm(VenueBuyerAgent).thenReturn(callTool(PlacePurchaseTool, VENUE));
    mockLlm(FlightBuyerAgent).thenReturn(callTool(PlacePurchaseTool, FLIGHTS));

    const paused = await app.execute(OffsiteBookingWorkflowStart, REQUEST, OWNER);

    expect(paused.status).toBe(ExecutionStatus.Paused);
    expect(paused.pending.map((pause) => [pause.agent, pause.ask.arguments])).toEqual([
      ["venue-buyer-agent", VENUE],
      ["flight-buyer-agent", FLIGHTS],
    ]);
    expect(terminal.print.mock.calls).toHaveLength(2);
  });

  realTest(
    "both answered at once: the run goes on, each branch with its own answer",
    async ({ app, mockLlm, mockOf }) => {
      const terminal = mockOf(ApprovalTerminal);
      mockLlm(VenueBuyerAgent).thenReturn(
        callTool(PlacePurchaseTool, VENUE),
        replyWith(VenueBookingDto, { venue: "Lakeside Lodge", isBooked: true }),
      );
      mockLlm(FlightBuyerAgent).thenReturn(
        callTool(PlacePurchaseTool, FLIGHTS),
        replyWith(FlightBookingDto, { route: "TLV → LIS", isBooked: false }),
      );
      const paused = await app.execute(OffsiteBookingWorkflowStart, REQUEST, OWNER);

      const results = await Promise.all([
        app.resume({ pauseId: pauseIdOf(paused, "venue-buyer-agent"), decision: APPROVE }, OWNER),
        app.resume({ pauseId: pauseIdOf(paused, "flight-buyer-agent"), decision: DECLINE }, OWNER),
      ]);

      const finished = results.find((result) => result.status === ExecutionStatus.Finished);
      expect(finished).toFinishWith(OffsiteBookingWorkflowFinish, {
        summary: "venue Lakeside Lodge: booked; flights TLV → LIS: declined",
      });
      expect(terminal.print.mock.calls).toHaveLength(2);
    },
  );

  test("one answer pressed twice: the second gets NotPausedError", async ({
    app,
    mockLlm,
    mockOf,
  }) => {
    mockOf(ApprovalTerminal);
    mockLlm(VenueBuyerAgent).thenReturn(
      callTool(PlacePurchaseTool, VENUE),
      replyWith(VenueBookingDto, { venue: "Lakeside Lodge", isBooked: true }),
    );
    mockLlm(FlightBuyerAgent).thenReturn(callTool(PlacePurchaseTool, FLIGHTS));
    const paused = await app.execute(OffsiteBookingWorkflowStart, REQUEST, OWNER);
    const answer = { pauseId: pauseIdOf(paused, "venue-buyer-agent"), decision: APPROVE };
    const first = await app.resume(answer, OWNER);

    await expect(app.resume(answer, OWNER)).rejects.toBeInstanceOf(NotPausedError);
    expect(first.pending.map((pause) => pause.agent)).toEqual(["flight-buyer-agent"]);
  });

  test("the terminal channel prints the purchase with its pause's id", async ({ app, mockLlm }) => {
    const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    mockLlm(VenueBuyerAgent).thenReturn(callTool(PlacePurchaseTool, VENUE));
    mockLlm(FlightBuyerAgent).thenReturn(callTool(PlacePurchaseTool, FLIGHTS));

    const paused = await app.execute(OffsiteBookingWorkflowStart, REQUEST, OWNER);

    expect(output).toHaveBeenCalledWith(
      `\n[APPROVAL REQUIRED] Lakeside Lodge for $1800 (pause ${pauseIdOf(paused, "venue-buyer-agent")})\n`,
    );
  });
});
