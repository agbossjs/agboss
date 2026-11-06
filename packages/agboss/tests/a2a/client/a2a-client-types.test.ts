/**
 * #809 — the typed client at compile time: `@A2AAgent`'s DTOs type `execute`, a class whose
 * generics differ from them does not compile, an untyped agent is `send` only, and the options are
 * what the decorator takes.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  A2AAgent,
  A2AClient,
  A2AMesh,
  type A2AClientCall,
  type A2ATaskResult,
} from "../../../src/a2a/index.js";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { usd } from "../../../src/units/index.js";

class QuoteQuestionDto {
  @Text()
  sku!: string;
}

class QuoteDto {
  @Text()
  price!: string;
}

describe("#809: the typed client's types", () => {
  it("execute takes the input DTO and gives the output DTO", () => {
    @A2AAgent({
      name: "quote-a2a-agent",
      url: "https://quotes.example",
      target: { application: "quote-application", skill: "quote-workflow-start" },
      input: QuoteQuestionDto,
      output: QuoteDto,
      price: usd(0.01),
      mesh: A2AMesh.Required,
      allowedOrigins: ["https://rpc.quotes.example"],
    })
    class QuoteA2AAgent extends A2AClient<QuoteQuestionDto, QuoteDto> {}

    const agent = new QuoteA2AAgent();
    expectTypeOf<Parameters<QuoteA2AAgent["execute"]>[0]>().toEqualTypeOf<QuoteQuestionDto>();
    expectTypeOf<Awaited<ReturnType<QuoteA2AAgent["execute"]>>>().toEqualTypeOf<QuoteDto>();
    expectTypeOf<Awaited<ReturnType<QuoteA2AAgent["send"]>>>().toEqualTypeOf<A2ATaskResult>();
    expectTypeOf<A2AClientCall["contextId"]>().toEqualTypeOf<string | undefined>();
    expect(agent.contract).toMatchObject({
      application: "quote-application",
      skill: "quote-workflow-start",
    });
  });

  it("a class whose generics are not the decorator's DTOs does not compile", () => {
    // @ts-expect-error — the output DTO is QuoteDto, the class promises WorkflowFinishTextDto
    @A2AAgent({
      name: "bad-a2a-agent",
      url: "https://q.example",
      input: QuoteQuestionDto,
      output: QuoteDto,
    })
    class BadA2AAgent extends A2AClient<QuoteQuestionDto, WorkflowFinishTextDto> {}
    expect(new BadA2AAgent().url).toBe("https://q.example");
  });

  it("an untyped agent: no DTOs, an untyped A2AClient; one DTO alone does not compile", () => {
    @A2AAgent({ name: "chat-a2a-agent", url: "https://chat.example" })
    class ChatA2AAgent extends A2AClient {}
    expectTypeOf<string>().toExtend<Parameters<ChatA2AAgent["send"]>[0]>();

    // @ts-expect-error — an input without an output
    @A2AAgent({ name: "half-a2a-agent", url: "https://chat.example", input: WorkflowStartTextDto })
    class HalfA2AAgent extends A2AClient {}
    expect(new HalfA2AAgent().contract).toMatchObject({ input: WorkflowStartTextDto });
    expect(new ChatA2AAgent().contract).toEqual({});
  });

  it("the target is { application?, skill? } — start is gone", () => {
    @A2AAgent({
      name: "old-a2a-agent",
      url: "https://old.example",
      // @ts-expect-error — `start` was renamed `skill` (#809)
      target: { application: "old-application", start: "old-workflow-start" },
    })
    class OldA2AAgent extends A2AClient {}
    expect(new OldA2AAgent().contract).toEqual({ application: "old-application" });
  });
});
