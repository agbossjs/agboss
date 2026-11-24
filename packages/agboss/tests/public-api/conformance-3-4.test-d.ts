import { describe, expectTypeOf, it } from "vitest";
import {
  ChannelInterpreter,
  inline,
  type JudgedOutput,
  type ModelChannelInterpreterOptions,
  type ModelJudgeOptions,
  type PromptSource,
  type PauseError,
} from "../../src/index.js";
import {
  RagReranker,
  type CodeRagRerankerOptions,
  type ModelRagRerankerOptions,
} from "../../src/rag/index.js";
import type { ModelArbiterOptions } from "../../src/flow/decorators/arbiter.js";
import type { PlainTextDto } from "../../src/dto/index.js";

/** Conformance of parts 3 and 4: the forms the review settled, each pinned. */
describe("conformance: agents, judges, prompts, RAG, channels", () => {
  it("#1290: a judge reads toolCalls and files on JudgedOutput; the options are ModelJudgeOptions", () => {
    expectTypeOf<JudgedOutput<PlainTextDto>>().toHaveProperty("toolCalls");
    expectTypeOf<JudgedOutput<PlainTextDto>>().toHaveProperty("files");
    expectTypeOf<ModelJudgeOptions["prompt"]>().toEqualTypeOf<PromptSource>();
    // @ts-expect-error -- JudgedInput is gone
    expectTypeOf<import("../../src/index.js").JudgedInput<PlainTextDto>>().toBeObject();
  });

  it("#1347: an arbiter's and a reranker's prompt is a PromptSource", () => {
    expectTypeOf<ModelArbiterOptions["prompt"]>().toEqualTypeOf<PromptSource>();
    expectTypeOf<ModelRagRerankerOptions["prompt"]>().toEqualTypeOf<PromptSource | undefined>();
    expectTypeOf<CodeRagRerankerOptions["prompt"]>().toEqualTypeOf<undefined>();
    expectTypeOf<CodeRagRerankerOptions["model"]>().toEqualTypeOf<undefined>();
    // @ts-expect-error -- a bare text is no prompt
    RagReranker({ candidates: 3, prompt: "Prefer recent." });
    RagReranker({ candidates: 3, prompt: inline("Prefer recent.") });
    // @ts-expect-error -- a code reranker has no model
    RagReranker({ candidates: 3, deps: [], model: "x" });
  });

  it("#1310: a model channel interpreter's model is optional and it has a modelProvider", () => {
    expectTypeOf<ModelChannelInterpreterOptions["model"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ModelChannelInterpreterOptions>().toHaveProperty("modelProvider");
    expectTypeOf(ChannelInterpreter).toBeCallableWith({ prompt: inline("Read it.") });
    expectTypeOf(ChannelInterpreter).toBeCallableWith();
  });

  it("#1307: PermissionDenied is a PauseError variant", () => {
    expectTypeOf<PauseError.PermissionDenied>().toExtend<PauseError>();
    expectTypeOf<
      PauseError.ChannelInterpreterMissing["code"]
    >().toEqualTypeOf<"pause.channel-interpreter-missing">();
  });
});
