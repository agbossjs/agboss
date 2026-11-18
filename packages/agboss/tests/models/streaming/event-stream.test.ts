import { describe, expect, it } from "vitest";
import { EventScanner } from "../../../src/models/calls/event-stream.js";
import { ModelFailure } from "../../../src/models/model-failure.js";

const encoder = new TextEncoder();
const frame = (event: unknown): string =>
  `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`;
const delta = (content: string): unknown => ({
  choices: [{ index: 0, delta: { content }, finish_reason: null }],
});
const finish = { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };

describe("#1005: the scanner reads what a provider's events say", () => {
  const signalsOf = (...parts: string[]) => {
    const scanner = new EventScanner();
    return parts.flatMap((part) => scanner.push(encoder.encode(part)));
  };

  it("content, a finish and [DONE]; a role chunk, a usage chunk and a comment say nothing", () => {
    expect(
      signalsOf(
        ": keep-alive\n\n",
        frame({ choices: [{ delta: { role: "assistant", content: "" } }] }),
      ),
    ).toEqual([]);
    expect(signalsOf(frame(delta("a")))).toEqual([{ kind: "content" }]);
    expect(signalsOf(frame(finish), frame("[DONE]"))).toEqual([{ kind: "end" }, { kind: "end" }]);
    expect(signalsOf(frame({ choices: [], usage: { total_tokens: 3 } }))).toEqual([]);
    expect(signalsOf(frame({ choices: [{ delta: { tool_calls: [{ index: 0 }] } }] }))).toEqual([
      { kind: "content" },
    ]);
    expect(signalsOf(frame({ choices: [{ delta: { reasoning: "hmm" } }] }))).toEqual([
      { kind: "content" },
    ]);
  });

  it("an event split across chunks is read once it is whole; text with a finish is content, then the end", () => {
    const whole = frame({ choices: [{ delta: { content: "x" }, finish_reason: "stop" }] });

    expect(signalsOf(whole.slice(0, 10), whole.slice(10))).toEqual([
      { kind: "content" },
      { kind: "end" },
    ]);
    expect(signalsOf("data: not json\n\n", "event: ping\n\n")).toEqual([]);
  });

  it.each([
    [429, ModelFailure.RateLimited],
    [408, ModelFailure.Timeout],
    [503, ModelFailure.ServerError],
    [400, undefined],
    ["rate_limit_exceeded", ModelFailure.RateLimited],
    ["timeout", ModelFailure.Timeout],
    ["server_error", ModelFailure.ServerError],
    ["overloaded", ModelFailure.ServerError],
    ["invalid_request_error", undefined],
    ["context_length_exceeded", undefined],
  ])("an error object with code %s is %s", (code, failure) => {
    expect(signalsOf(frame({ error: { code, message: "boom" } }))).toEqual([
      { kind: "error", message: "boom", failure },
    ]);
  });

  it("a finish_reason error without an error object is an error", () => {
    const [signal] = signalsOf(frame({ choices: [{ delta: {}, finish_reason: "error" }] }));

    expect(signal).toEqual({
      kind: "error",
      message: "the stream failed",
      failure: ModelFailure.ServerError,
    });
  });
});

describe("#1125: what is progress of a stream and what is only its upkeep", () => {
  /** Whether each part, pushed in turn, carried progress. */
  const progressOf = (...parts: string[]): boolean[] => {
    const scanner = new EventScanner();
    return parts.map((part) => {
      scanner.push(encoder.encode(part));
      return scanner.progressed;
    });
  };

  it("a comment, blank lines and a CRLF comment are upkeep; a data line, a field and a partial data line are progress", () => {
    expect(progressOf(": keep-alive\n\n", "\n", ": x\r\n\r\n", "")).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(progressOf(frame(delta("a")), "event: ping\n", "da", "id: 7\n")).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  it("a line is a comment by its first character, however it is cut into chunks", () => {
    expect(progressOf(":", " still", " going", "\n", ": next\n")).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(progressOf("d", "ata: {", "}\n\n")).toEqual([true, true, true]); // the rest of a data line is that line's
  });

  it("a chunk with a comment and then data is progress; data and then a comment is progress", () => {
    expect(progressOf(": a\n" + frame(delta("a")))).toEqual([true]);
    expect(progressOf(frame(delta("a")) + ": a\n")).toEqual([true]);
  });
});

describe("#1329: the scanner reads an event's data lines as one payload", () => {
  const signalsOf = (...parts: string[]) => {
    const scanner = new EventScanner();
    return parts.flatMap((part) => scanner.push(encoder.encode(part)));
  };

  it("an {error} cut over two data lines is the error, not nothing", () => {
    expect(signalsOf('data: {"error":\ndata: {"code": 429, "message": "slow"}}\n\n')).toEqual([
      { kind: "error", message: "slow", failure: ModelFailure.RateLimited },
    ]);
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("content cut over two data lines (%s) is content, at its blank line", (_name, end) => {
    const text = `data: {"choices":${end}data: [{"delta": {"content": "x"}}]}${end}`;

    expect(signalsOf(text)).toEqual([]);
    expect(signalsOf(text, end)).toEqual([{ kind: "content" }]);
    expect(signalsOf(text.slice(0, 20), text.slice(20) + end)).toEqual([{ kind: "content" }]);
  });
});

describe("#1329: the scanner at the body's end", () => {
  const scan = (...parts: string[]) => {
    const scanner = new EventScanner();
    const pushed = parts.flatMap((part) => scanner.push(encoder.encode(part)));
    return { pushed, finished: scanner.finish() };
  };

  it("a last event with one line end, or none, is read whole at the end, never before", () => {
    const content = 'data: {"choices": [{"delta": {"content": "x"}}]}';

    expect(scan(`${content}\n`)).toEqual({ pushed: [], finished: [{ kind: "content" }] });
    expect(scan(content)).toEqual({ pushed: [], finished: [{ kind: "content" }] });
    expect(scan('data: {"error":{"code":429,"message":"slow"}}\n').finished).toEqual([
      { kind: "error", message: "slow", failure: ModelFailure.RateLimited },
    ]);
  });

  it("an event cut over two data lines is read as one at the end", () => {
    expect(scan('data: {"error":\ndata: {"message": "m"}}').finished).toEqual([
      { kind: "error", message: "m", failure: ModelFailure.ServerError },
    ]);
  });

  it("nothing is left after a blank line, nor of a cut JSON, a comment or a field", () => {
    expect(scan(frame(delta("a"))).finished).toEqual([]);
    expect(scan('data: {"choices": [').finished).toEqual([]);
    expect(scan(": keep-alive\n").finished).toEqual([]);
    expect(scan("event: ping").finished).toEqual([]);
    expect(scan().finished).toEqual([]);
  });
});
