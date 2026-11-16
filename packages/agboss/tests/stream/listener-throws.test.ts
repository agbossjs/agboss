/** #1004: a listener that throws never fails the run nor silences the other events (text, tool call). */
import { describe, expect } from "vitest";
import { ExecutionStatus } from "../../src/app/types.js";
import type { ExecutionStreamEvent } from "../../src/run/types.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import {
  Mailer,
  MailApplication,
  SendEmail,
  sent,
  Start as MailStart,
} from "../app/fixtures/mail.workflow.js";
import { answerOf, execute } from "../helpers/flow.js";
import { rejectingListener } from "./async-listener.js";

const test = testWith(MailApplication);

describe("#1004: a throwing onStream listener", () => {
  test("every event still reaches it and the run finishes (text and tool call)", async ({
    app,
    mockLlm,
  }) => {
    sent.length = 0;
    mockLlm(Mailer).thenReturn(callTool(SendEmail, { to: "dana" }), replyWith("Sent."));
    const heard: ExecutionStreamEvent[] = [];
    const listener = (event: ExecutionStreamEvent): void => {
      heard.push(event);
      throw new Error("listener broke");
    };

    const paused = await execute(app, MailStart, { text: "mail" });
    const done = await app.resume(answerOf(paused, { approved: true }), { onStream: listener });

    expect(done.status).toBe(ExecutionStatus.Finished);
    expect(sent).toHaveLength(1);
    expect(heard).toContainEqual({ kind: "toolCall", tool: "send-email-tool" });
    expect(heard).toContainEqual(expect.objectContaining({ kind: "textDelta", delta: "Sent." }));
  });
});

describe("#1124: an async onStream listener that rejects", () => {
  test("AC1+AC4: the run goes on, no unhandled rejection fires, every event is delivered", async ({
    app,
    mockLlm,
  }) => {
    sent.length = 0;
    mockLlm(Mailer).thenReturn(callTool(SendEmail, { to: "dana" }), replyWith("Sent."));
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => void rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const heard: ExecutionStreamEvent[] = [];
      const listener = rejectingListener((event) => heard.push(event));
      const paused = await execute(app, MailStart, { text: "mail" });
      const done = await app.resume(answerOf(paused, { approved: true }), { onStream: listener });
      await new Promise((resolve) => setImmediate(resolve));

      expect(done.status).toBe(ExecutionStatus.Finished);
      expect(heard).toContainEqual({ kind: "toolCall", tool: "send-email-tool" });
      expect(heard).toContainEqual(expect.objectContaining({ kind: "textDelta", delta: "Sent." }));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});
