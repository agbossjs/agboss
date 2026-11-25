/** #120 AC8, AC13, AC3: sensitive fields, sensitive context fields, a router's input, a model detection. */
import { describe, expect } from "vitest";
import { replyWith, routeTo, testWith } from "../../src/testing/index.js";
import { extractText } from "../../src/graph/multimodal.js";
import type { Class } from "../../src/components/injection.js";
import type { ModelScript } from "../../src/testing/script-book.js";
import { execute } from "../helpers/flow.js";
import { requestText, tokensIn } from "./boundary.helpers.js";
import {
  DeskAgent,
  DeskRouter,
  DeskStart,
  NamesPiiPolicy,
  SensitiveApplication,
} from "./sensitive.fixture.js";

const test = testWith(SensitiveApplication);

const FOUND = '{"found":[{"kind":"person-name","text":"Dana Cohen"}]}';

/** The detection model finds Dana Cohen wherever she is; nothing elsewhere. */
function scriptDetection(mockModel: (target: Class) => ModelScript): void {
  mockModel(NamesPiiPolicy).respondWith((request) =>
    replyWith(requestText(request).includes("Dana Cohen") ? FOUND : '{"found":[]}'),
  );
}

describe("#120 AC8: a sensitive DTO field goes through its action on the way into a model", () => {
  test("WorkflowStartTextDto.author is masked one-way: a placeholder for the model, never the value", async ({
    app,
    mockModel,
  }) => {
    scriptDetection(mockModel);
    mockModel(DeskRouter).thenReturn(routeTo(DeskAgent));
    const agent = mockModel(DeskAgent);
    agent.respondWith((request) => {
      return replyWith(
        `Hello ${requestText(request).includes("<author>") ? "<author>" : "nobody"}`,
      );
    });

    const result = await execute(app, DeskStart, { text: "hi", author: "zoe-7" });

    expect(requestText(agent.onlyRequest)).not.toContain("zoe-7");
    expect(tokensIn(requestText(agent.onlyRequest), "author")).toEqual([]);
    expect(result.output).toEqual({ text: "Hello <author>" });
  });
});

describe("#120 AC13: a sensitive context field is masked wherever it appears", () => {
  test("the execution's userId never reaches the agent's model", async ({ app, mockModel }) => {
    scriptDetection(mockModel);
    mockModel(DeskRouter).thenReturn(routeTo(DeskAgent));
    const agent = mockModel(DeskAgent).thenReturn(replyWith("ok"));

    await execute(
      app,
      DeskStart,
      { text: "I am user u-98765" },
      { execution: { userId: "u-98765" } },
    );

    const sent = requestText(agent.onlyRequest);
    expect(sent).not.toContain("u-98765");
    expect(tokensIn(sent, "user-id")).toHaveLength(1);
  });
});

describe("#120 S38: a router's model reads its input masked", () => {
  test("the email in the message is a token in the decision request", async ({
    app,
    mockModel,
  }) => {
    scriptDetection(mockModel);
    const router = mockModel(DeskRouter).thenReturn(routeTo(DeskAgent));
    mockModel(DeskAgent).thenReturn(replyWith("ok"));

    await execute(app, DeskStart, { text: "write to bo@acme.com" });

    const input = extractText(router.onlyRequest.input);
    expect(input).not.toContain("bo@acme.com");
    expect(tokensIn(input, "email")).toHaveLength(1);
  });
});

describe("#120 AC3: model finds names in free text", () => {
  test("the name the model found is replaced; the detection is paid under pii:<policy>", async ({
    app,
    mockModel,
  }) => {
    scriptDetection(mockModel);
    mockModel(DeskRouter).thenReturn(routeTo(DeskAgent));
    const agent = mockModel(DeskAgent).thenReturn(replyWith("ok"));

    const result = await execute(app, DeskStart, { text: "Dana Cohen asks for a refund" });

    expect(requestText(agent.onlyRequest)).toContain("<person-name> asks for a refund");
    expect(Object.keys(result.spend.byCaller)).toContain("pii:names-pii-policy");
  });

  test("an answer that is not the JSON asked for fails closed", async ({ app, mockModel }) => {
    mockModel(NamesPiiPolicy).thenReturnAlways(replyWith("no idea"));
    mockModel(DeskRouter).thenReturn(routeTo(DeskAgent));
    // no script: the detection fails before the agent is asked (a call would fail the test)
    const agent = mockModel(DeskAgent);

    const failure = await execute(app, DeskStart, { text: "Dana Cohen" }).catch(
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({ code: "pii.detection-failed" });
    expect(agent.requests).toHaveLength(0);
  });
});
