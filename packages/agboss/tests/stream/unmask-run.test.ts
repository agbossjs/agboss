/**
 * #1007: the stream and `output` agree. A model writes a PII token in pieces, a made-up token, the
 * output of each PII action, a sensitive field's token; the deltas, joined, are the reply.
 */
import { describe, expect } from "vitest";
import type { ExecutionStreamEvent } from "../../src/run/types.js";
import { replyWith, routeTo, testWith, type ModelRequest } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import { requestText, tokensIn } from "../pii/boundary.helpers.js";
import {
  DeskAgent,
  DeskRouter,
  DeskStart,
  NamesPiiPolicy,
  SensitiveApplication,
} from "../pii/sensitive.fixture.js";
import { chunks, useChunks } from "./canary.js";
import { keptText } from "./kept-text.js";
import {
  AuditJudge,
  AuditJudgeApplication,
  AuditStart,
  AuditWriter,
  deltas,
} from "./writer.fixture.js";

useChunks();

/** The writer's first request. */
function firstRequestOf(script: { readonly requests: readonly ModelRequest[] }): ModelRequest {
  const [first] = script.requests;
  if (first === undefined) throw new Error("the writer was not asked");
  return first;
}
const writer = testWith(AuditJudgeApplication);
const desk = testWith(SensitiveApplication);
const EMAIL = "alice@example.com";

describe("#1007 AC1: a token the model writes is revealed in the stream", () => {
  writer(
    "the stream shows the address, never the token, at every piece size",
    async ({ app, mockLlm }) => {
      mockLlm(AuditWriter).thenReturn(replyWith("probe"));
      mockLlm(AuditJudge).thenReturnAlways(replyWith("PASS"));
      await execute(app, AuditStart, { text: `Mail ${EMAIL}` });
      const [token] = tokensIn(requestText(firstRequestOf(mockLlm(AuditWriter))), "email");
      expect(token).toBeDefined();

      for (const size of [1, 2, 3, 5, 8, 1000]) {
        chunks.size = size;
        mockLlm(AuditWriter).thenReturn(replyWith(`Write to ${token ?? ""}.`));
        const events: ExecutionStreamEvent[] = [];
        const done = await execute(
          app,
          AuditStart,
          { text: `Mail ${EMAIL}` },
          { onStream: (event) => events.push(event) },
        );

        expect(done.output).toEqual({ text: `Write to ${EMAIL}.` });
        expect(deltas(events).join(""), `size ${String(size)}`).toBe(`Write to ${EMAIL}.`);
        expect(deltas(events).join("")).not.toContain("<email:");
      }
    },
  );
});

describe("#1007 AC2: a made-up token is never shown as written", () => {
  writer(
    "it is shown as its kind, the attempt is refused, the retry is the answer",
    async ({ app, mockLlm }) => {
      chunks.size = 3;
      mockLlm(AuditWriter).thenReturn(replyWith("Write to <email:abcdef12>."), replyWith("Fine."));
      mockLlm(AuditJudge).thenReturn(replyWith("PASS"));
      const events: ExecutionStreamEvent[] = [];

      const done = await execute(
        app,
        AuditStart,
        { text: "Q" },
        { onStream: (event) => events.push(event) },
      );

      expect(JSON.stringify(events)).not.toContain("abcdef12");
      expect(events.find((event) => event.kind === "discarded")).toMatchObject({
        reason: "invalid-answer",
      });
      expect(keptText(events)).toBe("Fine.");
      expect(done.output).toEqual({ text: "Fine." });
    },
  );
});

describe("#1007 AC3: stream and output agree for every PII action", () => {
  writer("replaceWithToken: the revealed address", async ({ app, mockLlm }) => {
    mockLlm(AuditWriter).thenReturn(replyWith("probe"));
    mockLlm(AuditJudge).thenReturnAlways(replyWith("PASS"));
    await execute(app, AuditStart, { text: `Mail ${EMAIL}, bo@acme.com` });
    const tokens = tokensIn(requestText(firstRequestOf(mockLlm(AuditWriter))), "email");
    chunks.size = 4;
    mockLlm(AuditWriter).thenReturn(replyWith(`  ${tokens.join(" and ")}  \n`));
    const events: ExecutionStreamEvent[] = [];

    const done = await execute(
      app,
      AuditStart,
      { text: `Mail ${EMAIL}, bo@acme.com` },
      { onStream: (event) => events.push(event) },
    );

    expect(done.output).toEqual({ text: deltas(events).join("") });
    expect(tokens).toHaveLength(2);
  });

  writer(
    "replacePart: what the model writes of the masked number is the output",
    async ({ app, mockLlm }) => {
      chunks.size = 2;
      mockLlm(AuditWriter).thenReturn(replyWith("Call me: ********67 <ok>"));
      mockLlm(AuditJudge).thenReturn(replyWith("PASS"));
      const events: ExecutionStreamEvent[] = [];

      const done = await execute(
        app,
        AuditStart,
        { text: "Call 555 123 4567" },
        { onStream: (event) => events.push(event) },
      );

      expect(done.output).toEqual({ text: "Call me: ********67 <ok>" });
      expect(deltas(events).join("")).toBe("Call me: ********67 <ok>");
    },
  );

  desk("replaceWithKind: the kind the model wrote is the output", async ({ app, mockLlm }) => {
    chunks.size = 3;
    mockLlm(NamesPiiPolicy).thenReturnAlways(replyWith('{"found":[]}'));
    mockLlm(DeskRouter).thenReturn(routeTo(DeskAgent));
    mockLlm(DeskAgent).thenReturn(replyWith("Hello <person-name>, welcome."));
    const events: ExecutionStreamEvent[] = [];

    const done = await execute(
      app,
      DeskStart,
      { text: "hi" },
      { onStream: (event) => events.push(event) },
    );

    expect(done.output).toEqual({ text: "Hello <person-name>, welcome." });
    expect(deltas(events).join("")).toBe("Hello <person-name>, welcome.");
  });

  writer("an address the model writes itself streams as written", async ({ app, mockLlm }) => {
    mockLlm(AuditWriter).thenReturn(replyWith("Write to bob@example.org."));
    mockLlm(AuditJudge).thenReturn(replyWith("PASS"));
    const events: ExecutionStreamEvent[] = [];

    await execute(app, AuditStart, { text: "Q" }, { onStream: (event) => events.push(event) });

    expect(deltas(events).join("")).toBe("Write to bob@example.org.");
  });
});

describe("#1007 AC4: a sensitive field's token is revealed like any other", () => {
  desk("a sensitive DTO field", async ({ app, mockLlm }) => {
    chunks.size = 2;
    mockLlm(NamesPiiPolicy).thenReturnAlways(replyWith('{"found":[]}'));
    mockLlm(DeskRouter).thenReturn(routeTo(DeskAgent));
    mockLlm(DeskAgent).thenAnswer((request) => {
      const [token] = tokensIn(requestText(request), "author");
      return replyWith(`Hello ${token ?? "nobody"}`);
    });
    const events: ExecutionStreamEvent[] = [];

    const done = await execute(
      app,
      DeskStart,
      { text: "hi", author: "zoe-7" },
      { onStream: (event) => events.push(event) },
    );

    expect(done.output).toEqual({ text: "Hello zoe-7" });
    expect(deltas(events).join("")).toBe("Hello zoe-7");
  });

  desk("a sensitive context field", async ({ app, mockLlm }) => {
    chunks.size = 3;
    mockLlm(NamesPiiPolicy).thenReturnAlways(replyWith('{"found":[]}'));
    mockLlm(DeskRouter).thenReturn(routeTo(DeskAgent));
    mockLlm(DeskAgent).thenAnswer((request) => {
      const [token] = tokensIn(requestText(request), "user-id");
      return replyWith(`You are ${token ?? "nobody"}!`);
    });
    const events: ExecutionStreamEvent[] = [];

    await execute(
      app,
      DeskStart,
      { text: "I am u-98765" },
      { execution: { userId: "u-98765" }, onStream: (event) => events.push(event) },
    );

    expect(deltas(events).join("")).toBe("You are u-98765!");
  });
});
