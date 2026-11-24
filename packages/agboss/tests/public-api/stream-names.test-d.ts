import { describe, expect, expectTypeOf, it } from "vitest";
import {
  StreamDiscardReason,
  StreamEventKind,
  type ExecutionStreamEvent,
  type StreamStep,
} from "../../src/index.js";
import type {
  FinishReason,
  ModelProviderStream,
  ModelProviderStreamResult,
  TokenUsage,
} from "../../src/models/index.js";
import type { Usd } from "../../src/units/index.js";

/**
 * #1311 (1311a): a streamed call settles with `result` — `{ usage, cost?, finishReason? }`, the
 * shape `complete()`'s answer holds beside its text — and the stream's events are named by the
 * `StreamEventKind` and `StreamDiscardReason` enums; a tool-call event carries its `step`. The old
 * forms are gone with no alias: each is a compile error.
 */

type EventOf<TKind extends StreamEventKind> = Extract<ExecutionStreamEvent, { kind: TKind }>;

const STEP: StreamStep = { agent: "a-agent", visit: 1, branch: "e-1", attempt: 1 };

describe("#1311: ModelProviderStream.result", () => {
  it("a stream settles with `result`, not `usage`", () => {
    expectTypeOf<ModelProviderStream["result"]>().toEqualTypeOf<
      Promise<ModelProviderStreamResult>
    >();
    expectTypeOf<ModelProviderStream>().not.toHaveProperty("usage");
    const stream = {} as ModelProviderStream;
    // @ts-expect-error — `usage` is gone: read `(await stream.result).usage` (#1311)
    expect(stream.usage).toBeDefined();
  });

  it("`result` is { usage: TokenUsage, cost?, finishReason? }, symmetric with ModelProviderResponse", () => {
    expectTypeOf<ModelProviderStreamResult["usage"]>().toEqualTypeOf<TokenUsage>();
    expectTypeOf<ModelProviderStreamResult["cost"]>().toEqualTypeOf<Usd | undefined>();
    expectTypeOf<ModelProviderStreamResult["finishReason"]>().toEqualTypeOf<
      FinishReason | undefined
    >();
    // @ts-expect-error — the usage is no longer spread at the top level of the result
    const flat: ModelProviderStreamResult = { inputTokens: 1, outputTokens: 2 };
    expect(flat).toBeDefined();
  });

  it("ModelProviderStreamUsage is gone from @agboss/core/models", () => {
    // @ts-expect-error — `ModelProviderStreamUsage` is `ModelProviderStreamResult` (#1311)
    type Old = import("../../src/models/index.js").ModelProviderStreamUsage;
    expectTypeOf<Old>().toBeAny();
  });
});

describe("#1311: StreamEventKind and StreamDiscardReason", () => {
  it("the kinds are an enum with kebab-case values", () => {
    expectTypeOf<ExecutionStreamEvent["kind"]>().toEqualTypeOf<StreamEventKind>();
    expectTypeOf<`${StreamEventKind}`>().toEqualTypeOf<"text-delta" | "discarded" | "tool-call">();
  });

  it("the old camelCase literals do not compile", () => {
    // @ts-expect-error — "textDelta" is `StreamEventKind.TextDelta`
    const text: ExecutionStreamEvent = { kind: "textDelta", delta: "x", step: STEP };
    // @ts-expect-error — "toolCall" is `StreamEventKind.ToolCall`
    const tool: ExecutionStreamEvent = { kind: "toolCall", tool: "t", step: STEP };
    // @ts-expect-error — "discarded" is `StreamEventKind.Discarded`
    const gone: ExecutionStreamEvent = { kind: "discarded", step: STEP, reason: "failed" };
    expect([text, tool, gone]).toBeDefined();
  });

  it("a retraction's reason is a StreamDiscardReason, not a string", () => {
    expectTypeOf<
      EventOf<StreamEventKind.Discarded>["reason"]
    >().toEqualTypeOf<StreamDiscardReason>();
    expectTypeOf<`${StreamDiscardReason}`>().toEqualTypeOf<
      "judge-rejected" | "tool-turn" | "invalid-answer" | "stream-broken" | "failed"
    >();
    const reason: StreamDiscardReason = StreamDiscardReason.JudgeRejected;
    expect(reason).toBeDefined();
    // @ts-expect-error — a bare string is no reason: `StreamDiscardReason.JudgeRejected`
    const bare: StreamDiscardReason = "judge-rejected";
    expect(bare).toBeDefined();
  });

  it("DiscardReason is gone from @agboss/core", () => {
    // @ts-expect-error — `DiscardReason` is `StreamDiscardReason` (#1311)
    type Old = import("../../src/index.js").DiscardReason;
    expectTypeOf<Old>().toBeAny();
  });
});

describe("#1311: every event carries its step", () => {
  it("a tool-call event has the step of the model call that asked for it", () => {
    expectTypeOf<EventOf<StreamEventKind.ToolCall>["step"]>().toEqualTypeOf<StreamStep>();
    expectTypeOf<EventOf<StreamEventKind.TextDelta>["step"]>().toEqualTypeOf<StreamStep>();
    expectTypeOf<EventOf<StreamEventKind.Discarded>["step"]>().toEqualTypeOf<StreamStep>();
    const tool: ExecutionStreamEvent = { kind: StreamEventKind.ToolCall, tool: "t", step: STEP };
    expect(tool).toBeDefined();
    // @ts-expect-error — a tool-call event without its step does not compile
    const stepless: ExecutionStreamEvent = { kind: StreamEventKind.ToolCall, tool: "t" };
    expect(stepless).toBeDefined();
  });
});
