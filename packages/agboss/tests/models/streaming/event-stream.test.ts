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
