/** #1328b: the types of the one unit runner, the services, and the removed names. */
import { describe, expectTypeOf, it } from "vitest";
import { provide, InjectionToken } from "../../src/components/injection.js";
import {
  failStreamAfter,
  ModelFailure,
  streamWith,
  testDto,
  testService,
  testUnit,
  testWith,
  type GuardrailRunner,
  type JudgeRunner,
  type ModelScript,
  type PiiRunner,
  type RagRunner,
  type ToolRunner,
} from "../../src/testing/index.js";
import type * as Testing from "../../src/testing/index.js";
import { ContactPiiPolicy, GroundedJudge, HandbookRag, SearchJobsTool } from "./fixtures/units.js";

class Order {
  readonly id = "";
}

describe("#1328b: testUnit's runner is the component's", () => {
  it("a tool, a judge, a knowledge base by their handler", () => {
    expectTypeOf(testUnit(SearchJobsTool)).toExtend<ToolRunner<never, unknown>>();
    expectTypeOf(testUnit(GroundedJudge)).toExtend<JudgeRunner<never>>();
    expectTypeOf(testUnit(HandbookRag)).toEqualTypeOf<RagRunner>();
  });

  it("a list of policies is the PII runner; a class of none gives every other runner in one", () => {
    expectTypeOf(testUnit([ContactPiiPolicy])).toEqualTypeOf<PiiRunner>();
    expectTypeOf(testUnit(ContactPiiPolicy)).toExtend<GuardrailRunner>();
  });

  it("services take classes and provide(…) values", () => {
    const TOKEN = new InjectionToken<string>("token");
    testWith(Order, { services: [SearchJobsTool, provide(TOKEN, "x")] });
    // @ts-expect-error — a value is bound to a token, not a bare value
    testWith(Order, { services: ["x"] });
    testService(SearchJobsTool, { services: [provide(TOKEN, "x")] });
  });

  it("a stream is a turn of a text agent's script", () => {
    expectTypeOf(streamWith(["a"]).kind).toEqualTypeOf<"stream">();
    expectTypeOf<ModelScript["thenReturn"]>().toBeFunction();
    failStreamAfter(["a"], ModelFailure.Timeout);
  });

  it("testDto's value is the DTO", () => {
    expectTypeOf(testDto(Order).validate({})).toEqualTypeOf<Order>();
  });

  it("the per-kind runners and override are gone", () => {
    // @ts-expect-error — testUnit(Tool) is the runner of a tool
    type _Tool = typeof Testing.testTool;
    // @ts-expect-error — `services` replaces override(…)
    type _Override = typeof Testing.override;
  });
});
