import { ComponentKind } from "../../../src/flow/runtime/records.js";
import { describe, expectTypeOf, it } from "vitest";
import type {
  AGBossTypes,
  InstanceOrSelf,
  KindOf,
  NameOf,
  MissingGeneratedTypes,
} from "../../../src/flow/generated-types.js";
import type * as flow from "../../../src/public/flow.js";
import type * as flowTypes from "../../../src/public/flow-types.js";
import type { JudgeInput } from "../../../src/components/judge-decorators.js";
import type { DeskAnswerDto, RefundRecordedJudge } from "../fixtures/eval-desk.fixture.js";
import { ChargeCardAction, CreditWorkflowStart, DeskRouter } from "../fixtures/credit.fixture.js";

/**
 * #1324g — a component class is branded `{ name, kind }` by `.agboss/types.d.ts`; `NameOf` and
 * `KindOf` read the brand off an instance or a class alike, never the name's suffix; the tables
 * live in the one namespace `AGBossTypes`.
 */
describe("#1324g: the brand carries the name and the kind", () => {
  it("NameOf reads an instance and a class alike", () => {
    expectTypeOf<NameOf<ChargeCardAction>>().toEqualTypeOf<"charge-card-action">();
    expectTypeOf<NameOf<typeof ChargeCardAction>>().toEqualTypeOf<"charge-card-action">();
    expectTypeOf<NameOf<typeof DeskRouter>>().toEqualTypeOf<"desk-router">();
  });

  it("KindOf reads the declared kind of an instance and of a class", () => {
    expectTypeOf<KindOf<ChargeCardAction>>().toEqualTypeOf<ComponentKind.Action>();
    expectTypeOf<KindOf<typeof DeskRouter>>().toEqualTypeOf<ComponentKind.Router>();
    expectTypeOf<KindOf<typeof CreditWorkflowStart>>().toEqualTypeOf<ComponentKind.WorkflowStart>();
  });

  it("an unbranded class has neither a name nor a kind", () => {
    class Plain {
      readonly value = 1;
    }
    expectTypeOf<NameOf<Plain>>().toBeNever();
    expectTypeOf<KindOf<typeof Plain>>().toBeNever();
  });

  it("InstanceOrSelf unwraps a class and leaves an instance", () => {
    expectTypeOf<InstanceOrSelf<typeof ChargeCardAction>>().toEqualTypeOf<ChargeCardAction>();
    expectTypeOf<InstanceOrSelf<ChargeCardAction>>().toEqualTypeOf<ChargeCardAction>();
  });
});

describe("#1324g: the generated tables are AGBossTypes", () => {
  it("AGBossTypes holds the tables the generated file fills", () => {
    expectTypeOf<AGBossTypes.Inputs>().toHaveProperty("charge-card-action");
    expectTypeOf<AGBossTypes.Outputs>().toHaveProperty("charge-card-action");
    expectTypeOf<AGBossTypes.Routes>().toHaveProperty("desk-router");
    expectTypeOf<flow.AGBossTypes.Inputs>().toEqualTypeOf<AGBossTypes.Inputs>();
  });

  it("the tables are not names of their own, and KindOfName is gone", () => {
    // @ts-expect-error — the table is `AGBossTypes.Inputs`
    expectTypeOf<flow.Inputs>();
    // @ts-expect-error — the table is `AGBossTypes.Outputs`
    expectTypeOf<flow.Outputs>();
    // @ts-expect-error — the table is `AGBossTypes.DtoBrands`
    expectTypeOf<flow.DtoBrands>();
    // @ts-expect-error — the kind is read from the brand, not from the name's suffix
    expectTypeOf<flowTypes.KindOfName<"x-agent">>();
  });
});

describe("#1290: JudgeInput<T> reads a judge class's output from JudgeOutputs, or a direct output", () => {
  it("a @Judge class, instance or class, gives the output its generated entry names", () => {
    expectTypeOf<AGBossTypes.JudgeOutputs>().toHaveProperty("refund-recorded-judge");
    expectTypeOf<JudgeInput<RefundRecordedJudge>["output"]>().toEqualTypeOf<DeskAnswerDto>();
    expectTypeOf<JudgeInput<typeof RefundRecordedJudge>["output"]>().toEqualTypeOf<DeskAnswerDto>();
  });

  it("a direct output type is read as it is", () => {
    expectTypeOf<JudgeInput<DeskAnswerDto>["output"]>().toEqualTypeOf<DeskAnswerDto>();
  });

  it("a judge class no generated entry names is MissingGeneratedTypes", () => {
    class Unlisted {
      judge(): number {
        return 1;
      }
    }
    expectTypeOf<JudgeInput<Unlisted>["output"]>().toEqualTypeOf<MissingGeneratedTypes>();
  });
});
