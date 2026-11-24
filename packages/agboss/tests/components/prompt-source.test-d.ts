import { describe, expectTypeOf, it } from "vitest";
import {
  inline,
  type InlinePrompt,
  type PromptFilePath,
  type PromptPart,
  type PromptSource,
} from "../../src/components/prompt-source.js";
import type { PromptOptions } from "../../src/components/prompt-options.js";

describe("#1347a: the prompt types", () => {
  it("a file path starts with ./, ../ or /; a part is a path or inline(); a source is one or a non-empty list", () => {
    expectTypeOf(inline("x")).toEqualTypeOf<InlinePrompt>();
    expectTypeOf<"./a.prompt.md">().toExtend<PromptFilePath>();
    expectTypeOf<"../a.prompt.md">().toExtend<PromptFilePath>();
    expectTypeOf<"/a.prompt.md">().toExtend<PromptFilePath>();
    expectTypeOf<"a.prompt.md">().not.toExtend<PromptFilePath>();
    expectTypeOf<InlinePrompt>().toExtend<PromptPart>();
    expectTypeOf<readonly [PromptPart, ...PromptPart[]]>().toExtend<PromptSource>();
    expectTypeOf<readonly []>().not.toExtend<PromptSource>();
  });

  it("prompt takes a file, inline() or a list of them — and no bare text", () => {
    expectTypeOf<{ prompt: "./a.prompt.md" }>().toExtend<PromptOptions>();
    expectTypeOf<{ prompt: InlinePrompt }>().toExtend<PromptOptions>();
    expectTypeOf<{ prompt: readonly ["./a.prompt.md", InlinePrompt] }>().toExtend<PromptOptions>();
    expectTypeOf<{ prompt: "bare text" }>().not.toExtend<PromptOptions>();
  });
});
