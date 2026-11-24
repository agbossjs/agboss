import { describe, expectTypeOf, it } from "vitest";
import type { ApplicationOptions } from "../../src/application/application.js";
import type { Class } from "../../src/components/injection.js";
import type { AgentOptions } from "../../src/flow/decorators/agent.js";
import type { WorkflowOptions } from "../../src/flow/decorators/workflow.js";
import type { RuleCode } from "../../src/graph/rule-codes.js";
import {
  DecisionsDriver,
  ModelKind,
  ModelProvider,
  OpenAiCompatibleDriver,
  OpenRouterDriver,
  type ChatModelDriver,
  type DecisionsModelDriver,
  type DriverModelProviderOptions,
  type ModelProblemCode,
} from "../../src/models/index.js";

/** #1313a: driver providers, the model cascade, and the one ModelKind. */
describe("#1313a: drivers and the cascade", () => {
  it("each driver is of the kind it speaks", () => {
    expectTypeOf(OpenAiCompatibleDriver).returns.toEqualTypeOf<ChatModelDriver>();
    expectTypeOf(OpenRouterDriver).returns.toEqualTypeOf<ChatModelDriver>();
    expectTypeOf(DecisionsDriver).returns.toEqualTypeOf<DecisionsModelDriver>();
    expectTypeOf<keyof typeof ModelKind>().toEqualTypeOf<"Chat" | "Decisions">();
  });

  it("a driver provider has no serves, baseUrl or apiKey of its own", () => {
    expectTypeOf<DriverModelProviderOptions["serves"]>().toEqualTypeOf<undefined>();
    expectTypeOf<DriverModelProviderOptions["baseUrl"]>().toEqualTypeOf<undefined>();
    expectTypeOf<DriverModelProviderOptions["apiKey"]>().toEqualTypeOf<undefined>();
    // @ts-expect-error — a literal is no driver: only a driver function makes one
    ModelProvider({ driver: { kind: ModelKind.Chat } });
  });

  it("every level of the cascade takes a provider class; an agent's model is optional", () => {
    expectTypeOf<ApplicationOptions["modelProvider"]>().toEqualTypeOf<Class | undefined>();
    expectTypeOf<WorkflowOptions["modelProvider"]>().toEqualTypeOf<Class | undefined>();
    expectTypeOf<AgentOptions["modelProvider"]>().toEqualTypeOf<Class | undefined>();
    expectTypeOf<AgentOptions["model"]>().toEqualTypeOf<string | undefined>();
  });

  it("the new problems are rule codes and model problem codes", () => {
    expectTypeOf<
      "model.missing-provider" | "model.incompatible-provider" | "model.missing"
    >().toExtend<RuleCode>();
    expectTypeOf<
      "model.missing-provider" | "model.incompatible-provider" | "model.missing"
    >().toExtend<ModelProblemCode>();
  });
});
