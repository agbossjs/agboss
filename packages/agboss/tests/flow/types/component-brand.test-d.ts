import { describe, expectTypeOf, it } from "vitest";
import { NodeKind } from "../../../src/flow/ast.js";
import type {
  AGBossTypes,
  InstanceOrSelf,
  KindOf,
  NameOf,
} from "../../../src/flow/generated-types.js";
import type * as flow from "../../../src/public/flow.js";
import type * as flowTypes from "../../../src/public/flow-types.js";
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
    expectTypeOf<KindOf<ChargeCardAction>>().toEqualTypeOf<NodeKind.Action>();
    expectTypeOf<KindOf<typeof DeskRouter>>().toEqualTypeOf<NodeKind.Router>();
    expectTypeOf<KindOf<typeof CreditWorkflowStart>>().toEqualTypeOf<NodeKind.Start>();
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
