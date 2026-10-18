/** #120 S38, AC5, AC9: PII is masked into the model and revealed out of it — only there. */
import { describe, expect, it } from "vitest";
import { PiiRefusedError } from "../../src/index.js";
import { callTool, replyWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { execute } from "../helpers/flow.js";
import { piiApp, requestText, tokensIn } from "./boundary.helpers.js";
import { Outbox, PiiStart, SendEmail } from "./pii.fixture.js";

const MESSAGE = "Write to alice@example.com, my phone is +1 555 123 4567.";

/** The agent writes to the email it was given as a token, then answers with the token. */
function scriptedEmailRound(book: ScriptBook): void {
  const script = book.scriptOf("agent:support-agent");
  script.thenAnswer((request) => {
    const [token] = tokensIn(requestText(request), "email");
    return script.requests.length === 1
      ? callTool(SendEmail, { to: token ?? "", body: "hello" })
      : replyWith(`Done, I wrote to ${token ?? ""}.`);
  });
}

describe("#120 AC9: the model sees a token, the tool gets the real value", () => {
  it("masks the input message and reveals the call before the tool runs", async () => {
    const book = new ScriptBook();
    scriptedEmailRound(book);
    const { app } = await piiApp(book);

    const result = await execute(app, PiiStart, { text: MESSAGE });

    const [first] = book.scriptOf("agent:support-agent").requests;
    const sent = first === undefined ? "" : requestText(first);
    expect(sent).not.toContain("alice@example.com");
    expect(tokensIn(sent, "email")).toHaveLength(1);
    expect(sent).toContain("•••• 67");
    expect(sent).not.toContain("555 123");
    expect(app.resolve(Outbox).sent).toEqual(["alice@example.com"]);
    expect(result.output).toEqual({ text: "Done, I wrote to alice@example.com." });
    await app.close();
  });

  it("closes the tool's result: its text and its sensitive fields are masked for the model", async () => {
    const book = new ScriptBook();
    scriptedEmailRound(book);
    const { app } = await piiApp(book);

    await execute(app, PiiStart, { text: MESSAGE });

    const second = book.scriptOf("agent:support-agent").lastRequest;
    const text = requestText(second);
    expect(text).not.toContain("alice@example.com");
    expect(text).not.toContain("ACC-77");
    expect(tokensIn(text, "account")).toHaveLength(1);
    await app.close();
  });

  it("an unknown token is an invalid answer: the model reads why, the tool never runs", async () => {
    const book = new ScriptBook();
    book
      .scriptOf("agent:support-agent")
      .thenReturn(callTool(SendEmail, { to: "<email:abcdef>", body: "hi" }), replyWith("Sorry."));
    const { app } = await piiApp(book);

    const result = await execute(app, PiiStart, { text: MESSAGE });

    const retry = requestText(book.scriptOf("agent:support-agent").lastRequest);
    expect(retry).toContain("<email:abcdef> is not a token of this conversation");
    expect(app.resolve(Outbox).sent).toEqual([]);
    expect(result.output).toEqual({ text: "Sorry." });
    await app.close();
  });
});

describe("#120 AC5: blockWithRefusal", () => {
  const CARD = "4111 1111 1111 1111";

  it("an incoming message fails the execution with the refusal, before any model call", async () => {
    const { app, book } = await piiApp();

    const failure = await execute(app, PiiStart, { text: `my card is ${CARD}` }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(PiiRefusedError);
    expect(failure).toMatchObject({
      code: "pii.refused",
      kind: "card-number",
      refusal: "Please do not send a card-number.",
    });
    expect(book.scriptOf("agent:support-agent").requests).toHaveLength(0);
    await app.close();
  });

  it("tool arguments reject only that call", async () => {
    const book = new ScriptBook();
    book
      .scriptOf("agent:support-agent")
      .thenReturn(callTool(SendEmail, { to: "bob@example.com", body: CARD }), replyWith("ok"));
    const { app } = await piiApp(book);

    const result = await execute(app, PiiStart, { text: "write to bob" });

    expect(app.resolve(Outbox).sent).toEqual([]);
    const retry = requestText(book.scriptOf("agent:support-agent").lastRequest);
    expect(retry).toContain("Tool error: the call was refused: Please do not send a card-number.");
    expect(result.output).toEqual({ text: "ok" });
    await app.close();
  });

  it("a tool result rejects only that call", async () => {
    const book = new ScriptBook();
    book
      .scriptOf("agent:support-agent")
      .thenReturn(callTool(SendEmail, { to: "bob@example.com", body: "x" }), replyWith("ok"));
    const { app } = await piiApp(book);
    app.resolve(Outbox).note = ` (charged ${CARD})`;

    await execute(app, PiiStart, { text: "write to bob" });

    expect(app.resolve(Outbox).sent).toEqual(["bob@example.com"]);
    const retry = requestText(book.scriptOf("agent:support-agent").lastRequest);
    expect(retry).toContain("Tool error: the call was refused");
    expect(retry).not.toContain("4111");
    await app.close();
  });

  it("an answer fails the execution", async () => {
    const book = new ScriptBook();
    book.scriptOf("agent:support-agent").thenReturn(replyWith(`Your card: ${CARD}`));
    const { app } = await piiApp(book);

    const failure = await execute(app, PiiStart, { text: "hi" }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PiiRefusedError);
    await app.close();
  });
});

describe("#120 AC3: the kinds a policy names, a project's own detector", () => {
  it("a group rule (application level) replaces every kind of the group", async () => {
    const book = new ScriptBook();
    book.scriptOf("agent:support-agent").thenReturn(replyWith("ok"));
    const { app } = await piiApp(book);

    await execute(app, PiiStart, { text: "SSN 123-45-6789, NINO AB 12 34 56 C" });

    const sent = requestText(book.scriptOf("agent:support-agent").onlyRequest);
    expect(sent).toContain("SSN <us-ssn>, NINO <uk-nino>");
    await app.close();
  });

  it("a @PiiPolicy handler's matches get its action", async () => {
    const book = new ScriptBook();
    book.scriptOf("agent:support-agent").thenReturn(replyWith("ok"));
    const { app } = await piiApp(book);

    await execute(app, PiiStart, { text: "employee EMP-0042 asks" });

    const sent = requestText(book.scriptOf("agent:support-agent").onlyRequest);
    expect(sent).not.toContain("EMP-0042");
    expect(tokensIn(sent, "employee-id")).toHaveLength(1);
    await app.close();
  });
});
