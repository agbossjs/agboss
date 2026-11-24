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
import type { MissingGeneratedTypes } from "../../src/flow/generated-types.js";
import { OffRouteRouter } from "./units/fakes.js";
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

  it("a router whose answer `agboss check` has not generated gives MissingGeneratedTypes, not a runner", () => {
    expectTypeOf(testUnit(OffRouteRouter)).toEqualTypeOf<MissingGeneratedTypes>();
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

describe("#1328d: the pause vocabulary of the fixtures", () => {
  it("answerPause and replyToPause take the target first and answer with the execution's output", () => {
    expectTypeOf<Testing.WorkflowFixtures["replyToPause"]>().parameter(1).toEqualTypeOf<string>();
    expectTypeOf<Testing.WorkflowFixtures["answerPause"]>().returns.resolves.toHaveProperty(
      "status",
    );
  });
});

describe("#1328b: testModule, testAgent and the boundary mocks", () => {
  it("a module and an agent are built asynchronously; the agent is a function of its input message", () => {
    expectTypeOf<typeof Testing.testModule>().returns.resolves.toHaveProperty("runAgent");
    expectTypeOf<Awaited<ReturnType<typeof Testing.testAgent>>>().toBeCallableWith("input");
    expectTypeOf<Awaited<ReturnType<typeof Testing.testAgent>>>().returns.resolves.toBeString();
  });

  it("mockRag and mockA2A give a stub that takes answers, failures and a reset", () => {
    expectTypeOf<Testing.WorkflowFixtures["mockRag"]>().returns.toEqualTypeOf<Testing.RagStub>();
    expectTypeOf<Testing.RagStub["calls"]>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<Testing.A2AStub["thenFail"]>().toBeFunction();
    // @ts-expect-error — a stub takes errors, not values, as failures
    void ({} as Testing.RagStub).thenFail("down");
  });
});
