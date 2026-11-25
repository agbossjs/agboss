import { describe, expectTypeOf, it } from "vitest";
import type { RuleCode } from "../../../src/graph/rule-codes.js";
import type { ValueWrite } from "../../../src/flow/analyse/flow-graph.js";
import { OutdatedReason, type ScopeValueRecord } from "../../../src/flow/runtime/records.js";
// @ts-expect-error — `ReturnsOptions` ({ about }) is gone (#1277)
import type { ReturnsOptions } from "../../../src/public/flow.js";

/** #1277 — `{ about }` and `[io.ambiguous-cycle]` are removed completely. */
describe("#1277: { about } is gone", () => {
  it("no record, write, step or reason carries an about", () => {
    expectTypeOf<ScopeValueRecord>().not.toHaveProperty("about");
    expectTypeOf<ValueWrite>().not.toHaveProperty("about");
    expectTypeOf<keyof typeof OutdatedReason>().toEqualTypeOf<"Replaced" | "BuiltFromReplaced">();
  });

  it("the three rule codes are gone", () => {
    expectTypeOf<"input.outdated-on-path">().toExtend<RuleCode>();
    expectTypeOf<"io.ambiguous-cycle">().not.toExtend<RuleCode>();
    expectTypeOf<"io.ambiguous-about">().not.toExtend<RuleCode>();
    expectTypeOf<"io.about-on-start">().not.toExtend<RuleCode>();
  });

  it("the type of an unused ReturnsOptions import stays unreferenced", () => {
    expectTypeOf<ReturnsOptions>().toBeAny();
  });
});
