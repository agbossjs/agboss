/**
 * #906 D1, at compile time: the errors that are not `AGBossError`s have the same shape — a literal
 * instance `code` — over every entry that exports one, so a `switch (error.code)` narrows over them
 * too. The classes of the entries are read from their modules, not listed.
 */
import { describe, expectTypeOf, it } from "vitest";
import * as dto from "../../src/dto/index.js";
import * as root from "../../src/index.js";
import * as models from "../../src/models/index.js";
import * as testing from "../../src/testing/index.js";
import * as contracts from "../../src/testing/contracts/index.js";
import * as faults from "../../src/testing/faults/index.js";
import * as units from "../../src/units/index.js";
import type {
  AppCloseTimeoutError,
  CassetteMissingError,
  LiveCallBlockedError,
  TestFailure,
} from "../../src/testing/index.js";
import type { StoreConformanceError } from "../../src/testing/contracts/index.js";
import type { EnvironmentError, EnvironmentErrorCode } from "../../src/index.js";
import type { UnitError } from "../../src/units/index.js";

type ErrorClassesOf<M> = {
  [K in keyof M as M[K] extends abstract new (...args: never) => Error ? K : never]: M[K];
};
type InstanceOf<C> = C extends abstract new (...args: never) => infer I ? I : never;
/** The exported error classes whose instance has no `code`, or one typed as the wide `string`. */
type NoLiteralCode<M> = {
  [K in keyof ErrorClassesOf<M>]: InstanceOf<ErrorClassesOf<M>[K]> extends {
    readonly code: infer C;
  }
    ? string extends C
      ? K
      : never
    : K;
}[keyof ErrorClassesOf<M>];

describe("#906 D1: every error class has a literal code on its instance", () => {
  it("no exported error but the base `AGBossError` has none, in any entry with errors", () => {
    expectTypeOf<NoLiteralCode<typeof root>>().toEqualTypeOf<"AGBossError">();
    expectTypeOf<NoLiteralCode<typeof dto>>().toEqualTypeOf<never>();
    expectTypeOf<NoLiteralCode<typeof models>>().toEqualTypeOf<never>();
    expectTypeOf<NoLiteralCode<typeof units>>().toEqualTypeOf<never>();
    expectTypeOf<NoLiteralCode<typeof testing>>().toEqualTypeOf<never>();
    expectTypeOf<NoLiteralCode<typeof contracts>>().toEqualTypeOf<never>();
    expectTypeOf<NoLiteralCode<typeof faults>>().toEqualTypeOf<never>();
  });

  it("the leaves' codes are their classes' literals", () => {
    expectTypeOf<UnitError["code"]>().toEqualTypeOf<"config.unit">();
    expectTypeOf<LiveCallBlockedError["code"]>().toEqualTypeOf<"test.live-call-blocked">();
    expectTypeOf<CassetteMissingError["code"]>().toEqualTypeOf<"test.cassette-missing">();
    expectTypeOf<AppCloseTimeoutError["code"]>().toEqualTypeOf<"test.close-timeout">();
    expectTypeOf<EnvironmentError["code"]>().toEqualTypeOf<EnvironmentErrorCode>();
  });

  it("a store set's refusal narrows over its first problem's rule", () => {
    expectTypeOf<"store-conformance">().toExtend<StoreConformanceError["code"]>();
    expectTypeOf<"store-conformance.missing-fencing-contract">().toExtend<
      StoreConformanceError["code"]
    >();
    expectTypeOf<"store-conformance.nothing-of-the-kind">().not.toExtend<
      StoreConformanceError["code"]
    >();
  });

  it("a switch over test failures narrows to the subclass", () => {
    const narrowed = (error: TestFailure | LiveCallBlockedError | AppCloseTimeoutError): number => {
      switch (error.code) {
        case "test.close-timeout":
          expectTypeOf(error).toEqualTypeOf<AppCloseTimeoutError | TestFailure>();
          return 1;
        default:
          return 0;
      }
    };

    expectTypeOf(narrowed).returns.toBeNumber();
  });
});
