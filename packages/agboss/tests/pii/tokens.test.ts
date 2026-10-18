/** #120 S38: the token map is the execution's `piiTokens` channel — kept by a pause and a recovery. */
import { describe, expect } from "vitest";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { maskedText } from "../../src/pii/masking.js";
import { PiiAction } from "../../src/index.js";
import { execute } from "../helpers/flow.js";
import { requestText, tokensIn } from "./boundary.helpers.js";
import {
  approvedRecipients,
  MailApplication,
  MailerAgent,
  MailStart,
  SendApprovedEmail,
} from "./tokens.fixture.js";

const approve = { approved: true, by: "dana" };
const test = testWith(MailApplication);

describe("#120: tokens survive a pause, a resume and a recovery", () => {
  test("the tool after the approval and the reply after the recovery get the real email", async ({
    app,
    mockLlm,
    recoverApp,
  }) => {
    const script = mockLlm(MailerAgent);
    script.thenAnswer((request) => {
      const [token] = tokensIn(requestText(request), "email");
      return script.requests.length === 1
        ? callTool(SendApprovedEmail, { to: token ?? "", body: "hi" })
        : replyWith(`Sent to ${token ?? ""}.`);
    });

    const paused = await execute(app, MailStart, { text: "mail dana@acme.com" });
    const restarted = await recoverApp();
    const done = await restarted.resume(paused.threadId, approve);

    expect(paused.pause).toMatchObject({ args: { to: "dana@acme.com" } });
    expect(approvedRecipients).toEqual(["dana@acme.com"]);
    expect(done.output).toEqual({ text: "Sent to dana@acme.com." });
  });
});

describe("#120: what is stored", () => {
  test("replaceWithKind and replacePart make no tokens", () => {
    const text = "call 555 and 000000018";
    const findings = [
      { start: 5, end: 8, label: "phone", action: PiiAction.replacePart({ keepLast: 1 }) },
      { start: 13, end: 22, label: "israeli-id", action: PiiAction.replaceWithKind() },
    ].map((item) => ({ ...item, policy: "p", key: "k", rank: 0 }));

    expect(maskedText(text, findings, {})).toEqual({
      text: "call •••• 5 and <israeli-id>",
      tokens: {},
      blocked: [],
    });
  });
});
