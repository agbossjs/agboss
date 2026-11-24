import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { FinishReason, finishReasonOf, isCutAtLimit } from "../../src/models/finish-reason.js";

const said = (finish_reason: unknown): AIMessage =>
  new AIMessage({ content: "", response_metadata: { finish_reason } });

describe("#1313e: FinishReason", () => {
  it("names stop, length, tool_calls and content_filter, as the OpenAI contract does", () => {
    expect(Object.values(FinishReason)).toEqual(["stop", "length", "tool_calls", "content_filter"]);
  });

  it("reads the reason a message reports, in a provider's own words too", () => {
    expect(finishReasonOf(said("stop"))).toBe(FinishReason.Stop);
    expect(finishReasonOf(said("tool_calls"))).toBe(FinishReason.ToolCalls);
    expect(finishReasonOf(said("function_call"))).toBe(FinishReason.ToolCalls);
    expect(finishReasonOf(said("content_filter"))).toBe(FinishReason.ContentFilter);
    expect(finishReasonOf(said("max_tokens"))).toBe(FinishReason.Length);
  });

  it("a reason it does not know, or none, is undefined", () => {
    expect(finishReasonOf(said("weird"))).toBeUndefined();
    expect(finishReasonOf(said(undefined))).toBeUndefined();
    expect(finishReasonOf(new AIMessage({ content: "" }))).toBeUndefined();
  });

  it("only a cut answer is cut at the limit", () => {
    expect(isCutAtLimit(said("length"))).toBe(true);
    expect(isCutAtLimit(said("stop"))).toBe(false);
  });
});
