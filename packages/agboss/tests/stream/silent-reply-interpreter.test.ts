/** #1004 AC1, with the canary: the reply interpreter of a pause is silent on the resume's stream. */
import { describe, expect } from "vitest";
import { ToolCallApprovalDecisionDto } from "../../src/dto/standard/framework.js";
import type { ExecutionStreamEvent } from "../../src/run/types.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import {
  PayOutTool,
  PayoutReplyInterpreter,
  replyDesk,
  resetReplyDesk,
  TreasurerAgent,
  TreasuryApplication,
  TreasuryWorkflowStart,
} from "../flow/fixtures/replies.fixture.js";
import { execute } from "../helpers/flow.js";
import { deltas } from "./writer.fixture.js";
import { beforeEach } from "vitest";
import { canaries, useCanary } from "./canary.js";

useCanary();
beforeEach(resetReplyDesk);
const test = testWith(TreasuryApplication);

describe("#1004: the reply interpreter is silent", () => {
  test("AC1: the interpreter's canary is not heard; the agent's answer after the approval is", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(TreasurerAgent).thenReturn(
      callTool(PayOutTool, { payee: "ann", amountCents: 120_000 }),
      replyWith("Paid."),
    );
    mockLlm(PayoutReplyInterpreter).thenReturn(
      replyWith(ToolCallApprovalDecisionDto, { approved: true }),
    );
    await execute(app, TreasuryWorkflowStart, { text: "pay ann $1200" });
    const [ask] = replyDesk.asks;
    const events: ExecutionStreamEvent[] = [];

    await app.resume(
      { pauseId: ask?.pauseId ?? "", reply: "yes" },
      { answeredBy: "manager-17", onStream: (event) => events.push(event) },
    );

    expect(mockLlm(PayoutReplyInterpreter).requests).toHaveLength(1);
    expect(canaries(events)).toBe(1);
    expect(deltas(events)).toEqual(["CANARY", "Paid."]);
  });
});
