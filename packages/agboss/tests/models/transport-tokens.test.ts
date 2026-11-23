/**
 * #1366: the tokens a transport's answer releases to the provider's per-minute window — input plus output; none
 * when the answer reports no numbers it can be read by.
 */
import { describe, expect, it, vi } from "vitest";
import { tokensOf, transportCarrier } from "../../src/models/transport/transport-carrier.js";
import type { ModelProviderResponse } from "../../src/models/transport/transport.js";

const answerOf = (usage: unknown): ModelProviderResponse => ({ text: "ok", usage }) as never;

describe("#1366: the tokens of a transport's answer", () => {
  it("are the input tokens and the output tokens together", () => {
    expect(tokensOf(answerOf({ inputTokens: 100, outputTokens: 20 }))).toBe(120);
  });

  it("are 0 when a number is missing or not a number, or the usage is none", () => {
    expect(tokensOf(answerOf({ inputTokens: 100 }))).toBe(0);
    expect(tokensOf(answerOf({ inputTokens: "many", outputTokens: 20 }))).toBe(0);
    expect(tokensOf(answerOf(null))).toBe(0);
    expect(tokensOf(answerOf(undefined))).toBe(0);
  });

  it("the carrier releases the room with the answer's tokens, and returns the answer itself", () => {
    const release = vi.fn(() => Promise.resolve());
    const carrier = transportCarrier(
      () => Promise.reject(new Error("unused")),
      { model: "m" } as never,
      undefined,
      "p",
    );
    const answer = answerOf({ inputTokens: 7, outputTokens: 5 });

    expect(carrier.hold(answer, release)).toBe(answer);
    expect(release).toHaveBeenCalledExactlyOnceWith(12);
  });
});
