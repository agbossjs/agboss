import { beforeEach, describe, expect } from "vitest";
import type { RunStreamEvent } from "../../src/run/types.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import {
  Charge,
  Clerk,
  Probe,
  ReceiptDto,
  resetSeen,
  seen,
  Start,
  CheckoutApplication,
} from "./fixtures/run-context.workflow.js";
import { execute } from "../helpers/flow.js";
import {
  Mailer,
  MailApplication,
  SendEmail,
  sent,
  Start as MailStart,
} from "./fixtures/mail.workflow.js";
import { ExecutionStatus } from "../../src/app/types.js";

const approve = { approved: true, by: "dana" };
const checkout = testWith(CheckoutApplication);

beforeEach(resetSeen);

describe("#280: a tool and an action read their execution through ExecutionContext", () => {
  checkout(
    "a tool sees the execution's id, thread and its own step; the action its own",
    async ({ app, mockLlm }) => {
      mockLlm(Clerk).thenReturn(
        callTool(Probe, { text: "order 7" }),
        replyWith(ReceiptDto, { text: "Found." }),
      );

      const done = await execute(app, Start, { text: "look up order 7" }, { owner: "dana" });

      expect(done.status).toBe(ExecutionStatus.Finished);
      const [probe] = seen.probes;
      const [payment] = seen.payments;
      expect(probe).toMatchObject({
        executionId: done.runId,
        threadId: done.thread,
        ownerId: "dana",
      });
      expect(probe?.step).toMatchObject({ nodeId: "clerk-agent", visitNumber: 1, copyNumber: 1 });
      expect(probe?.step.callId).toEqual(expect.any(String));
      expect(probe?.step.idempotencyKey).toBe(
        `${done.runId}:clerk-agent:1:${String(probe?.step.callId)}`,
      );
      expect(payment?.step).toMatchObject({
        nodeId: "pay-action",
        callId: undefined,
        idempotencyKey: `${done.runId}:pay-action:1`,
      });
      expect(probe?.signal.aborted).toBe(false);
    },
  );

  checkout(
    "the execution id and a tool call's key stay the same across a pause and its resume",
    async ({ app, mockLlm }) => {
      mockLlm(Clerk).thenReturn(
        callTool(Probe, { text: "card" }),
        callTool(Charge, { text: "10 USD" }),
        replyWith(ReceiptDto, { text: "Charged." }),
      );

      const paused = await execute(app, Start, { text: "charge" });
      const done = await app.resume(paused.thread, approve);

      expect(paused.status).toBe(ExecutionStatus.Paused);
      expect(done.status).toBe(ExecutionStatus.Finished);
      const [probe] = seen.probes;
      const [charge] = seen.charges;
      expect(charge?.executionId).toBe(probe?.executionId);
      expect(charge?.step.visitNumber).toBe(1);
      expect(charge?.step.idempotencyKey).toBe(
        `${done.runId}:clerk-agent:1:${String(charge?.step.callId)}`,
      );
      // the action after the pause runs once
      expect(seen.payments).toHaveLength(1);
    },
  );
});

const mail = testWith(MailApplication);

describe("#181: execute and resume forward onStream", () => {
  mail(
    "AC2: a caller passing onStream to app.execute receives stream events",
    async ({ app, mockLlm }) => {
      mockLlm(Mailer).thenReturn(replyWith("Hello there."));
      const events: RunStreamEvent[] = [];

      await execute(app, MailStart, { text: "hi" }, { onStream: (event) => events.push(event) });

      expect(events).toContainEqual({ kind: "textDelta", delta: "Hello there." });
    },
  );

  mail("resume forwards onStream too", async ({ app, mockLlm }) => {
    sent.length = 0;
    mockLlm(Mailer).thenReturn(callTool(SendEmail, { to: "dana" }), replyWith("Sent."));
    const events: RunStreamEvent[] = [];

    const paused = await execute(
      app,
      MailStart,
      { text: "mail" },
      { configurable: { region: "eu" } },
    );
    await app.resume(paused.thread, approve, { onStream: (event) => events.push(event) });

    expect(events).toContainEqual({ kind: "textDelta", delta: "Sent." });
  });
});
