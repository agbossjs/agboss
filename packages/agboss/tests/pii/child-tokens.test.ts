/**
 * #120 S84 × #263: a child workflow starts with its parent's PII tokens and gives its own back —
 * with its value, or with its error, so the parent's side path reveals what the child masked.
 */
import { describe, expect } from "vitest";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import { requestText, tokensIn } from "./boundary.helpers.js";
import { SendEmail } from "./pii.fixture.js";
import {
  ClosingAgent,
  FailedHandoverStart,
  FailedListStart,
  HandoverApplication,
  HandoverStart,
  IntakeAgent,
  IntakeDto,
  ListRecoveryAgent,
  NotifierAgent,
  NoteDto,
  NotifyTool,
  RecoveryAgent,
} from "./child-tokens.fixture.js";

const test = testWith(HandoverApplication);

/** A token of `label` the scripted model saw in its last request. */
const tokenSeen = (requests: readonly Parameters<typeof requestText>[0][], label: string): string =>
  requests.flatMap((request) => tokensIn(requestText(request), label)).at(-1) ?? "";

describe("#120 × #263: PII tokens across a child workflow", () => {
  test("parent → child → parent: each side reveals a token only the other side minted", async ({
    app,
    mockLlm,
  }) => {
    const intake = mockLlm(IntakeAgent);
    intake.thenReturn(
      callTool(SendEmail, { to: "dana@acme.com", body: "hi" }),
      replyWith(IntakeDto, { text: "noted" }),
    );
    let account = "";
    const notifier = mockLlm(NotifierAgent);
    notifier.thenAnswer(() => {
      if (notifier.requests.length === 1) {
        // the parent's account token: in the intake's last request, never in the child's
        account = tokenSeen(intake.requests, "account");
        return callTool(NotifyTool, { to: "lee@acme.com" });
      }
      return replyWith(NoteDto, { text: `ref ${account}` });
    });
    let lee = "";
    const closing = mockLlm(ClosingAgent);
    closing.thenAnswer(() => {
      lee = tokenSeen(notifier.requests, "email");
      return replyWith(`notified ${lee}`);
    });

    const result = await execute(app, HandoverStart, { text: "mail dana@acme.com" });

    expect(account).toMatch(/^<account:[0-9a-f]+>$/);
    expect(notifier.requests.map((request) => requestText(request)).join("\n")).not.toContain(
      account,
    );
    expect(result.children).toMatchObject([
      { workflow: { name: "notify-workflow" }, output: { text: "ref ACC-77" } },
    ]);
    expect(lee).toMatch(/^<email:[0-9a-f]+>$/);
    expect(closing.requests.map(requestText).join("\n")).not.toContain(lee);
    expect(result.output).toEqual({ text: "notified lee@acme.com" });
  });

  test("a failed child's tokens come back with its error: the side path reveals them", async ({
    app,
    mockLlm,
  }) => {
    const notifier = mockLlm(NotifierAgent);
    notifier.thenReturn(
      callTool(NotifyTool, { to: "lee@acme.com" }),
      replyWith(NoteDto, { text: "done" }),
    );
    const recovery = mockLlm(RecoveryAgent);
    recovery.thenAnswer(() => replyWith(`failed for ${tokenSeen(notifier.requests, "email")}`));

    const result = await execute(app, FailedHandoverStart, { text: "notify lee" });

    expect(result.handledErrors).toMatchObject([{ error: { code: "step.child" } }]);
    expect(recovery.requests.map(requestText).join("\n")).not.toMatch(/<email:/);
    expect(result.output).toEqual({ text: "failed for lee@acme.com" });
  });

  test("a failed per-item child's tokens come back with the branch's error, to the join's side path", async ({
    app,
    mockLlm,
  }) => {
    const notifier = mockLlm(NotifierAgent);
    notifier.thenReturn(
      callTool(NotifyTool, { to: "lee@acme.com" }),
      replyWith(NoteDto, { text: "done" }),
    );
    const recovery = mockLlm(ListRecoveryAgent);
    recovery.thenAnswer(() => replyWith(`failed for ${tokenSeen(notifier.requests, "email")}`));

    const result = await execute(app, FailedListStart, [{ text: "notify lee" }]);

    expect(result.handledErrors).toMatchObject([{ error: { code: "step.child" } }]);
    expect(result.output).toEqual({ text: "failed for lee@acme.com" });
  });
});
