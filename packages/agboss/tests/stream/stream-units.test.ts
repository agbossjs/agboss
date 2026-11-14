/** #1048: the stream's own units — the sink, an attempt's text, a visit's stream, the token handler. */
import { describe, expect, it } from "vitest";
import type { FrameworkLog } from "../../src/infrastructure/logger.js";
import { STREAM_DISCARD_EVENT } from "../../src/models/stream-discard.js";
import { AgentStream, AttemptStream } from "../../src/run/stream/agent-stream.js";
import { AnswerTokenHandler, withAnswerHandler } from "../../src/run/stream/answer-handler.js";
import { RunStream } from "../../src/run/stream/run-stream.js";
import type { ExecutionStreamEvent } from "../../src/run/types.js";

const SITE = { agent: "a-agent", visit: 1, branch: "e1" };

/** A sink that keeps what it hears. */
function sinkOf(): { sink: RunStream; heard: ExecutionStreamEvent[] } {
  const heard: ExecutionStreamEvent[] = [];
  return { sink: new RunStream((event) => heard.push(event)), heard };
}

/** What a consumer shows: a delta as its text, a retraction as `[reason]`. */
const told = (heard: readonly ExecutionStreamEvent[]): string[] =>
  heard.flatMap((event) => {
    if (event.kind === "textDelta") return [event.delta];
    return event.kind === "discarded" ? [`[${event.reason}]`] : [];
  });

describe("RunStream: a throwing listener", () => {
  it("is logged once per run with the run's ids and the error's class, never the event", () => {
    const logged: { code: string; message: string; subject: unknown }[] = [];
    const log: FrameworkLog = {
      info: () => undefined,
      error: () => undefined,
      warn: (code, message, subject) => logged.push({ code, message, subject }),
    };
    let calls = 0;
    const stream = new RunStream(
      () => {
        calls += 1;
        throw new TypeError("secret text");
      },
      log,
      { executionId: "e1", tenantId: "t1" },
    );

    stream.emit({ kind: "toolCall", tool: "x" });
    stream.emit({ kind: "toolCall", tool: "x" });
    stream.emit({ kind: "toolCall", tool: "x" });

    expect(calls).toBe(3); // every event still goes to the listener
    expect(logged).toHaveLength(1);
    expect(logged[0]?.code).toBe("stream.listener-failed");
    expect(logged[0]?.message).toContain("TypeError");
    expect(logged[0]?.message).not.toContain("secret text");
    expect(logged[0]?.subject).toEqual({ executionId: "e1", tenantId: "t1" });
  });

  it("names a thrown non-error by its type", () => {
    const messages: string[] = [];
    const log: FrameworkLog = {
      info: () => undefined,
      error: () => undefined,
      warn: (_code, message) => messages.push(message),
    };
    new RunStream(() => {
      throw JSON.parse('"text"'); // a listener may throw anything: a string here
    }, log).emit({ kind: "toolCall", tool: "x" });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("(string)");
  });

  it("without a log, the run goes on and says nothing", () => {
    const stream = new RunStream(() => {
      throw new Error("x");
    });

    expect(() => {
      stream.emit({ kind: "toolCall", tool: "x" });
    }).not.toThrow();
  });
});

describe("AttemptStream: one model call's text", () => {
  it("streams at once, with its step, and is retracted once, never twice", () => {
    const { sink, heard } = sinkOf();
    const attempt = new AgentStream(sink, SITE, false).begin(2);

    attempt.push("Hel");
    attempt.push("lo");
    attempt.discard("judge-rejected");
    attempt.discard("failed");

    expect(heard).toEqual([
      { kind: "textDelta", delta: "Hel", step: { ...SITE, attempt: 2 } },
      { kind: "textDelta", delta: "lo", step: { ...SITE, attempt: 2 } },
      { kind: "discarded", step: { ...SITE, attempt: 2 }, reason: "judge-rejected" },
    ]);
  });

  it("an attempt that showed nothing retracts nothing", () => {
    const { sink, heard } = sinkOf();
    const attempt = new AgentStream(sink, SITE, false).begin(1);

    attempt.push("   "); // leading whitespace is not streamed
    attempt.discard("failed");

    expect(heard).toEqual([]);
  });

  it("a retracted attempt shows no more text", () => {
    const { sink, heard } = sinkOf();
    const attempt = new AgentStream(sink, SITE, false).begin(1);
    attempt.push("a");
    attempt.discard("failed");

    attempt.push("b");
    attempt.end();

    expect(told(heard)).toEqual(["a", "[failed]"]);
  });

  it("end() shows what was held back for a possible token, and drops trailing whitespace", () => {
    const { sink, heard } = sinkOf();
    const attempt = new AgentStream(sink, SITE, false).begin(1, {});

    attempt.push("a <b");
    attempt.push("c  ");
    attempt.end();
    attempt.push("d"); // after the end, the trailing whitespace is gone

    expect(told(heard).join("")).toBe("a <bcd");
  });

  it("end() with a PII map flushes an unclosed candidate as text", () => {
    const { sink, heard } = sinkOf();
    const attempt = new AgentStream(sink, SITE, false).begin(1, {});

    attempt.push("go <email:9cf");
    expect(told(heard).join("")).toBe("go");
    attempt.end();

    expect(told(heard).join("")).toBe("go <email:9cf");
  });

  it("end() without a PII map shows nothing more and does not throw", () => {
    const { sink, heard } = sinkOf();
    const attempt = new AgentStream(sink, SITE, false).begin(1);

    attempt.push("a <b");
    attempt.end();

    expect(told(heard)).toEqual(["a <b"]);
  });

  it("a PII map reveals a token the run minted", () => {
    const { sink, heard } = sinkOf();
    const attempt = new AgentStream(sink, SITE, false).begin(1, { "<email:9cf08e>": "a@b.c" });

    attempt.push("to <email:9cf08e>!");

    expect(told(heard).join("")).toBe("to a@b.c!");
  });

  it("a restart retracts what was shown, forgets the old reveal state and trim, and streams anew", () => {
    const { sink, heard } = sinkOf();
    const attempt = new AgentStream(sink, SITE, false).begin(1, { "<email:9cf08e>": "a@b.c" });
    attempt.push("one <email:9c"); // a token half written: held
    attempt.restart("stream-broken");
    attempt.push("f08e> two"); // the old half is forgotten: this is plain text now
    attempt.restart("stream-broken");
    attempt.push("  fresh <email:9cf08e>"); // the leading whitespace is trimmed again, the token revealed
    attempt.end();

    expect(told(heard)).toEqual([
      "one",
      "[stream-broken]",
      "f08e> two",
      "[stream-broken]",
      "fresh a@b.c",
    ]);
  });

  it("a restart without a PII map reveals nothing, and a second retraction is not made", () => {
    const { sink, heard } = sinkOf();
    const attempt = new AgentStream(sink, SITE, false).begin(1);
    attempt.push("a");
    attempt.restart("stream-broken");

    attempt.discard("failed"); // nothing was shown since the restart
    attempt.restart("stream-broken");
    attempt.push("<email:9cf08e>"); // no map: shown as written

    expect(told(heard)).toEqual(["a", "[stream-broken]", "<email:9cf08e>"]);
  });

  it("a restart of an attempt that showed nothing retracts nothing, and the next text streams", () => {
    const { sink, heard } = sinkOf();
    const attempt = new AgentStream(sink, SITE, false).begin(1);

    attempt.restart("stream-broken");
    attempt.push("x");
    attempt.discard("failed");

    expect(told(heard)).toEqual(["x", "[failed]"]);
  });

  it("a restart makes the attempt retractable again after a retraction", () => {
    const { sink, heard } = sinkOf();
    const attempt = new AgentStream(sink, SITE, false).begin(1);
    attempt.push("a");
    attempt.discard("judge-rejected");

    attempt.restart("stream-broken");
    attempt.push("b");
    attempt.discard("failed");

    expect(told(heard)).toEqual(["a", "[judge-rejected]", "b", "[failed]"]);
  });
});

describe("AttemptStream: a held attempt", () => {
  it("emits nothing until released, then every held piece in order", () => {
    const { sink, heard } = sinkOf();
    const attempt = new AgentStream(sink, SITE, true).begin(1);

    attempt.push("a");
    attempt.push("b");
    expect(heard).toEqual([]);
    attempt.release();
    attempt.release(); // released once

    expect(told(heard)).toEqual(["a", "b"]);
  });

  it("a rejected held attempt leaves no trace: no text, no retraction", () => {
    const { sink, heard } = sinkOf();
    const attempt = new AgentStream(sink, SITE, true).begin(1);

    attempt.push("secret");
    attempt.discard("judge-rejected");
    attempt.release();

    expect(heard).toEqual([]);
  });

  it("a released attempt is retracted like any shown one, once", () => {
    const { sink, heard } = sinkOf();
    const attempt = new AgentStream(sink, SITE, true).begin(1);
    attempt.push("ok");
    attempt.release();

    attempt.discard("failed");
    attempt.discard("failed");

    expect(told(heard)).toEqual(["ok", "[failed]"]);
  });

  it("a held attempt that released nothing retracts nothing", () => {
    const { sink, heard } = sinkOf();
    const attempt = new AgentStream(sink, SITE, true).begin(1);

    attempt.release();
    attempt.discard("failed");

    expect(heard).toEqual([]);
  });
});

describe("AgentStream: a visit", () => {
  it("numbers attempts as told and acts on the latest one only", () => {
    const { sink, heard } = sinkOf();
    const visit = new AgentStream(sink, SITE, false);
    const first = visit.begin(1);
    first.push("one");
    const second = visit.begin(2);
    second.push("two");

    visit.discardLast("judge-rejected");

    expect(heard).toEqual([
      { kind: "textDelta", delta: "one", step: { ...SITE, attempt: 1 } },
      { kind: "textDelta", delta: "two", step: { ...SITE, attempt: 2 } },
      { kind: "discarded", step: { ...SITE, attempt: 2 }, reason: "judge-rejected" },
    ]);
  });

  it("fail() retracts the latest attempt as `failed`", () => {
    const { sink, heard } = sinkOf();
    const visit = new AgentStream(sink, SITE, false);
    visit.begin(1).push("x");

    visit.fail();

    expect(told(heard)).toEqual(["x", "[failed]"]);
  });

  it("release() sends the latest held attempt's text", () => {
    const { sink, heard } = sinkOf();
    const visit = new AgentStream(sink, SITE, true);
    visit.begin(1).push("x");
    expect(heard).toEqual([]);

    visit.release();

    expect(told(heard)).toEqual(["x"]);
  });

  it("a visit that began nothing has nothing to retract, fail or release", () => {
    const { sink, heard } = sinkOf();
    const visit = new AgentStream(sink, SITE, false);

    visit.discardLast("judge-rejected");
    visit.fail();
    visit.release();

    expect(heard).toEqual([]);
  });
});

describe("AnswerTokenHandler", () => {
  it("prefers a stream unless the attempt is held back", () => {
    const { sink } = sinkOf();

    expect(
      new AnswerTokenHandler(new AgentStream(sink, SITE, false).begin(1)).lc_prefer_streaming,
    ).toBe(true);
    expect(
      new AnswerTokenHandler(new AgentStream(sink, SITE, true).begin(1)).lc_prefer_streaming,
    ).toBe(false);
  });

  it("hears tokens, skips an empty one, and restarts only on the discard event", () => {
    const { sink, heard } = sinkOf();
    const handler = new AnswerTokenHandler(new AgentStream(sink, SITE, false).begin(1));

    handler.handleLLMNewToken("a");
    handler.handleLLMNewToken("");
    handler.handleCustomEvent("some-other-event");
    handler.handleLLMNewToken("b");
    handler.handleCustomEvent(STREAM_DISCARD_EVENT);
    handler.handleLLMNewToken("c");

    expect(told(heard)).toEqual(["a", "b", "[stream-broken]", "c"]);
  });

  it("awaits its handlers and has a name", () => {
    const { sink } = sinkOf();
    const handler = new AnswerTokenHandler(new AgentStream(sink, SITE, false).begin(1));

    expect(handler.awaitHandlers).toBe(true);
    expect(handler.name).toBe("AnswerTokenHandler");
  });
});

describe("withAnswerHandler", () => {
  it("is the handler alone when the call had no callbacks", () => {
    const handler = new AnswerTokenHandler(new AgentStream(sinkOf().sink, SITE, false).begin(1));

    expect(withAnswerHandler(undefined, handler)).toEqual([handler]);
  });

  it("adds the handler after a list's own callbacks", () => {
    const handler = new AnswerTokenHandler(new AgentStream(sinkOf().sink, SITE, false).begin(1));
    const other = new AnswerTokenHandler(new AgentStream(sinkOf().sink, SITE, false).begin(1));

    expect(withAnswerHandler([other], handler)).toEqual([other, handler]);
  });
});
