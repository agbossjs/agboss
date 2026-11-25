import { describe, expectTypeOf, it } from "vitest";
import {
  WorkflowFinish,
  type WorkflowFinishOptions,
} from "../../../src/flow/decorators/workflow-finish.js";
import type { DtoClass } from "../../../src/dto/types.js";
import { listOf, oneOf, type ListWrapper } from "../../../src/flow/dto-wrappers.js";
import { CompanyDto, CompanyScoreDto } from "../fixtures/data-dtos.js";
// @ts-expect-error — `FinishHandler` is gone (#1271)
import type { FinishHandler } from "../../../src/public/flow.js";
// @ts-expect-error — `HandledFinishOptions` is gone (#1271)
import type { HandledFinishOptions } from "../../../src/public/dsl-types.js";
// @ts-expect-error — `PassThroughFinishOptions` is gone (#1271)
import type { PassThroughFinishOptions } from "../../../src/public/dsl-types.js";
// @ts-expect-error — `FinishMethod` is gone (#1271)
import type { FinishMethod } from "../../../src/public/flow-types.js";
// @ts-expect-error — `NoFinishMethod` is gone (#1271)
import type { NoFinishMethod } from "../../../src/public/flow-types.js";

/** #1271 — `@WorkflowFinish` is a pure boundary port: `{ name, description, output }` and an empty class. */
describe("#1271: @WorkflowFinish is a pure boundary port", () => {
  it("its options are the name, the description and the output", () => {
    expectTypeOf<keyof WorkflowFinishOptions>().toEqualTypeOf<"name" | "description" | "output">();
    expectTypeOf<WorkflowFinishOptions["output"]>().toEqualTypeOf<DtoClass | ListWrapper>();
  });

  it("the output is one DTO or a list of them", () => {
    expectTypeOf({
      name: "a-workflow-finish",
      description: "one",
      output: CompanyScoreDto,
    }).toExtend<WorkflowFinishOptions>();
    expectTypeOf({
      name: "b-workflow-finish",
      description: "many",
      output: listOf(CompanyDto),
    }).toExtend<WorkflowFinishOptions>();
    expectTypeOf({
      name: "c-workflow-finish",
      description: "many of several",
      output: listOf(CompanyDto, CompanyScoreDto),
    }).toExtend<WorkflowFinishOptions>();
  });

  it("input and deps are gone", () => {
    expectTypeOf<WorkflowFinishOptions>().not.toHaveProperty("input");
    expectTypeOf<WorkflowFinishOptions>().not.toHaveProperty("deps");
  });

  it("an empty class is a finish; a finish() method is a compile error", () => {
    @WorkflowFinish({
      name: "empty-workflow-finish",
      description: "Empty",
      output: CompanyScoreDto,
    })
    class EmptyWorkflowFinish {}

    // @ts-expect-error — a finish is a pure boundary port: it has no finish()
    @WorkflowFinish({
      name: "handled-workflow-finish",
      description: "Handled",
      output: CompanyScoreDto,
    })
    class HandledWorkflowFinish {
      finish(): CompanyScoreDto {
        return { score: "x" };
      }
    }

    expectTypeOf(EmptyWorkflowFinish).toBeConstructibleWith();
    expectTypeOf(HandledWorkflowFinish).toBeConstructibleWith();
  });

  it("the removed names stay unreferenced", () => {
    expectTypeOf<FinishHandler<never>>().toBeAny();
    expectTypeOf<HandledFinishOptions<never>>().toBeAny();
    expectTypeOf<PassThroughFinishOptions<never>>().toBeAny();
    expectTypeOf<FinishMethod>().toBeAny();
    expectTypeOf<NoFinishMethod<never>>().toBeAny();
  });
});
