/**
 * #267 AC3 / AC4: who may answer a pause is its role's `answeredBy` — `ThreadOwner`: `resume`
 * checks the thread's `ownerId`; `Channel`: `resume` takes a non-empty `answeredBy`, recorded on the
 * pause and in `onExecutionResume`; the other credential is refused, and a refused resume leaves the
 * pause waiting. A `Channel` pause's id is never listed to the caller (only its channel has it).
 */
import { beforeEach, describe, expect } from "vitest";
import { ExecutionStatus } from "../../src/app/types.js";
import {
  PauseAnswerer,
  PauseAnswererError,
  PauseStatus,
  ThreadOwnerError,
} from "../../src/index.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { answerOf, execute } from "../helpers/flow.js";
import {
  ConfirmOrderTool,
  DeskClerkAgent,
  DeskWorkflowFinish,
  DeskWorkflowStart,
  pauseStore,
  PausesApplication,
  RefundTool,
  resetPauses,
  seen,
} from "./fixtures/pauses.workflow.js";
import { answerFor, approve, askFor, manager } from "./fixtures/pause-scripts.js";

const test = testWith(PausesApplication);

beforeEach(resetPauses);

describe("#267 AC4: a ThreadOwner pause is answered by the thread's owner", () => {
  test("its id is listed; another owner, or answeredBy, is refused and it keeps waiting", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(DeskClerkAgent).thenReturn(
      callTool(ConfirmOrderTool, { orderId: "7" }),
      replyWith("Confirmed."),
    );
    const paused = await execute(
      app,
      DeskWorkflowStart,
      { text: "confirm 7" },
      { ownerId: "alice" },
    );

    const [pending] = paused.pending;
    expect(pending).toMatchObject({
      pauseId: seen.confirmations[0]?.pauseId,
      answeredBy: PauseAnswerer.ThreadOwner,
    });
    await expect(app.resume(answerOf(paused, approve), { ownerId: "bob" })).rejects.toBeInstanceOf(
      ThreadOwnerError,
    );
    await expect(app.resume(answerOf(paused, approve), manager)).rejects.toBeInstanceOf(
      PauseAnswererError,
    );
    const done = await app.resume(answerOf(paused, approve), { ownerId: "alice" });
    expect(done).toFinishWith(DeskWorkflowFinish, { text: "Confirmed." });
    expect(seen.confirmed).toEqual(["7"]);
    expect(seen.resumes.map((event) => event.answeredBy)).toEqual(["alice"]);
  });
});

describe("#267 AC3 / AC4: a Channel pause is answered through its channel", () => {
  test("the caller never sees its id: the channel was sent it", async ({ app, mockLlm }) => {
    mockLlm(DeskClerkAgent).thenReturn(callTool(RefundTool, { orderId: "7" }));

    const paused = await execute(app, DeskWorkflowStart, { text: "refund 7" });

    expect(paused.status).toBe(ExecutionStatus.Paused);
    expect(paused.pending).toHaveLength(1);
    expect(paused.pending[0]).not.toHaveProperty("pauseId");
    expect(seen.pauses[0]?.pending[0]).not.toHaveProperty("pauseId");
    expect(askFor("7").pauseId).toMatch(/^[0-9a-f]{32}$/);
  });

  test("ownerId, or no answeredBy, is refused; it keeps waiting", async ({ app, mockLlm }) => {
    mockLlm(DeskClerkAgent).thenReturn(callTool(RefundTool, { orderId: "7" }));
    await execute(app, DeskWorkflowStart, { text: "refund 7" }, { ownerId: "alice" });

    const asOwner = app.resume(answerFor("7"), { ownerId: "alice" });
    const anonymous = app.resume(answerFor("7"));
    const empty = app.resume(answerFor("7"), { answeredBy: " " });

    await expect(asOwner).rejects.toBeInstanceOf(PauseAnswererError);
    await expect(anonymous).rejects.toBeInstanceOf(PauseAnswererError);
    await expect(empty).rejects.toBeInstanceOf(PauseAnswererError);
    const stored = await pauseStore().findByTenantIdAndPauseId("default", askFor("7").pauseId);
    expect(stored?.status).toBe(PauseStatus.Pending);
    expect(seen.refunds).toEqual([]);
  });

  test("answeredBy is recorded on the pause and in onExecutionResume; the agent reads it", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(DeskClerkAgent).thenReturn(callTool(RefundTool, { orderId: "7" }), replyWith("Done."));
    await execute(app, DeskWorkflowStart, { text: "refund 7" }, { ownerId: "alice" });

    const done = await app.resume(answerFor("7", { approved: false, reason: "too late" }), manager);

    expect(done).toFinishWith(DeskWorkflowFinish, { text: "Done." });
    const stored = await pauseStore().findByTenantIdAndPauseId("default", askFor("7").pauseId);
    expect(stored).toMatchObject({
      status: PauseStatus.Taken,
      answer: { answerer: "manager-17", decision: { approved: false, reason: "too late" } },
    });
    expect(seen.resumes).toMatchObject([{ answeredBy: "manager-17" }]);
    expect(JSON.stringify(mockLlm(DeskClerkAgent).requests[1])).toContain(
      "the call was rejected by manager-17: too late",
    );
    expect(seen.refunds).toEqual([]);
  });
});
