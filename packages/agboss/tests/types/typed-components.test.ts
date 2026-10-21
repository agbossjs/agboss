import { describe, expect, it } from "vitest";
import {
  Agent,
  InputGuardrail,
  Injectable,
  Judge,
  JudgeVerdict,
  Tool,
  type ToolHandler,
} from "../../src/index.js";
import type { JudgeInput } from "../../src/index.js";
import {
  Integer,
  PlainTextDto,
  Text,
  isVariant,
  listOf,
  oneOf,
  type VariantOf,
} from "../../src/dto/index.js";

/**
 * #200 D4: compile-time checks of an agent's slots. Each `@ts-expect-error` below is a negative type
 * test — tsc fails this file if the line compiles. The flow's own compile-time checks (starts,
 * finishes, steps) are in tests/flow/types.test-d.ts and tests/flow/types/compile.test-d.ts.
 */
/** A service: it has methods, but it is no tool, judge, guardrail or flow node. */
@Injectable()
class JobFitJudge {
  rate(job: string): Promise<number> {
    return Promise.resolve(job.length);
  }
}

class Query {
  @Text() q!: string;
}

@Tool({ name: "search", description: "Searches", input: Query, output: Query })
class Search implements ToolHandler<Query, Query> {
  run(input: Query): Promise<Query> {
    return Promise.resolve(input);
  }
}

@Judge({ name: "fair", model: "test/judge", reply: PlainTextDto })
class Fair {
  judge(_input: JudgeInput<PlainTextDto>): Promise<JudgeVerdict> {
    return Promise.resolve(JudgeVerdict.passed());
  }
}

@InputGuardrail({
  name: "polite-guardrail",
  description: "Blocks rude messages",
  prompt: "Is the message rude?",
  threshold: 0.8,
  refusal: "Please be polite.",
})
class Polite {}

describe("#200 AC2: slots are typed by component kind", () => {
  it("tools and judges take their kind only (guardrails are checked at assembly, #120)", () => {
    @Agent({
      name: "typed-agent",
      description: "Typed slots",
      model: "test/alpha",
      prompt: "p",
      tools: [Search],
      judges: [Fair],
      guardrails: [Polite],
    })
    class Typed {}

    @Agent({
      name: "wrong-agent",
      description: "A service in every slot",
      model: "test/alpha",
      prompt: "p",
      // @ts-expect-error -- JobFitJudge is not a @Tool (no `run`)
      tools: [JobFitJudge],
      // @ts-expect-error -- JobFitJudge is not a @Judge (no `judge`)
      judges: [JobFitJudge],
    })
    class Wrong {}

    expect([Typed.name, Wrong.name]).toEqual(["Typed", "Wrong"]);
  });
});

describe("#262 S115: a judge judges the reply it declares, with a built verdict", () => {
  it("its handler's reply is its @Judge reply; a plain-object verdict does not compile", () => {
    // @ts-expect-error -- it declares reply: Query but judges a PlainTextDto
    @Judge({ name: "mismatched-judge", model: "test/judge", reply: Query })
    class Mismatched {
      judge(input: JudgeInput<PlainTextDto>): Promise<JudgeVerdict> {
        return Promise.resolve(
          input.reply.text === ""
            ? JudgeVerdict.failed({ reason: "empty" })
            : JudgeVerdict.passed(),
        );
      }
    }

    @Judge({ name: "plain-verdict-judge", model: "test/judge", reply: PlainTextDto })
    class PlainVerdict {
      judge(): Promise<JudgeVerdict> {
        // @ts-expect-error -- a verdict is built with JudgeVerdict.passed / JudgeVerdict.failed only
        return Promise.resolve({ passed: true });
      }
    }

    expect([Mismatched.name, PlainVerdict.name]).toEqual(["Mismatched", "PlainVerdict"]);
  });
});

class SalaryDto {
  @Integer() salary!: number;
}

class ReasonDto {
  @Text() why!: string;
}

describe("#262 S125: a oneOf judge reads its variant", () => {
  it("a listOf(oneOf(…)) judge reads VariantOf items, never bare values", () => {
    @Judge({ name: "items-judge", model: "test/judge", reply: listOf(oneOf(SalaryDto, ReasonDto)) })
    class Items {
      judge({
        reply,
      }: JudgeInput<readonly VariantOf<SalaryDto | ReasonDto>[]>): Promise<JudgeVerdict> {
        const paid = reply.some((item) => isVariant(item, SalaryDto) && item.value.salary > 0);
        return Promise.resolve(
          paid ? JudgeVerdict.passed() : JudgeVerdict.failed({ reason: "unpaid" }),
        );
      }
    }

    // @ts-expect-error -- the items of a listOf(oneOf(…)) reply are { variant, value }
    @Judge({
      name: "bare-items-judge",
      model: "test/judge",
      reply: listOf(oneOf(SalaryDto, ReasonDto)),
    })
    class BareItems {
      judge(_input: JudgeInput<readonly (SalaryDto | ReasonDto)[]>): Promise<JudgeVerdict> {
        return Promise.resolve(JudgeVerdict.passed());
      }
    }

    expect([Items.name, BareItems.name]).toEqual(["Items", "BareItems"]);
  });
});
