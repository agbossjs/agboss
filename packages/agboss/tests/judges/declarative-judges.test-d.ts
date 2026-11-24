import { describe, expectTypeOf, it } from "vitest";
import { PlainTextDto } from "../../src/dto/index.js";
import { Judge, JudgeModel, JudgeVerdict } from "../../src/index.js";
import { inline, type PromptSource } from "../../src/components/prompt-source.js";
import type { DeclarativeJudgeOptions } from "../../src/components/judge-declaration.js";

/** #1290b: the declarative `@Judge` overload and the forms it removed. */

class Empty {
  readonly nothing = true;
}

class Coded {
  judge(): JudgeVerdict {
    return JudgeVerdict.passed();
  }
}

describe("#1290b: the declarative @Judge overload", () => {
  it("an empty class takes a prompt (a file or inline), a threshold, a model", () => {
    Judge({ output: PlainTextDto, prompt: "./criterion.prompt.md" })(Empty);
    Judge({ output: PlainTextDto, prompt: inline("Be kind."), threshold: 0.8, model: "fast" })(
      Empty,
    );
    Judge({ output: PlainTextDto, prompt: ["./a.prompt.md", inline("and b")] })(Empty);
    expectTypeOf<DeclarativeJudgeOptions["prompt"]>().toEqualTypeOf<PromptSource>();
    expectTypeOf<DeclarativeJudgeOptions["threshold"]>().toEqualTypeOf<number | undefined>();
  });

  it("a class with judge(input) does not take the declarative form", () => {
    // @ts-expect-error -- a judge with a prompt is empty: its model decides, not its code
    Judge({ output: PlainTextDto, prompt: inline("x") })(Coded);
  });

  it("a declarative judge injects nothing", () => {
    // @ts-expect-error -- an empty class has no deps
    Judge({ output: PlainTextDto, prompt: inline("x"), deps: [JudgeModel] });
  });

  it("a bare text with no path prefix is no prompt file", () => {
    // @ts-expect-error -- a file starts with ./, ../ or /; text is inline(…)
    Judge({ output: PlainTextDto, prompt: "grounded.prompt.md" })(Empty);
  });

  it("a threshold belongs to a declarative judge", () => {
    // @ts-expect-error -- a code judge has no model verdict to score
    Judge({ output: PlainTextDto, threshold: 0.5 });
  });

  it("the removed forms do not compile: reply, decidedBy", () => {
    // @ts-expect-error -- `reply` is `output`
    Judge({ reply: PlainTextDto, prompt: inline("x") });
    // @ts-expect-error -- `decidedBy` is gone: a prompt, or a judge(input) method, decides
    Judge({ output: PlainTextDto, prompt: inline("x"), decidedBy: "model" });
  });

  it("a code judge still takes model and modelProvider only with JudgeModel in deps", () => {
    Judge({ output: PlainTextDto, deps: [JudgeModel], model: "m" });
    // @ts-expect-error -- no JudgeModel in deps
    Judge({ output: PlainTextDto, model: "m" });
  });
});
