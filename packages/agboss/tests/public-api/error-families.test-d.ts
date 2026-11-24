/**
 * #1325a, at compile time: a family is a union discriminated by `kind` (and by the literal `code`), a
 * variant's facts are not optional once `kind` is narrowed, `instanceof Family` and
 * `instanceof Family.Variant` narrow, a family and a variant are both an `ErrorClass` for `.onError` and
 * `toFailWith`, a variant's own facts are required by its constructor, and the removed forms are gone.
 */
import { describe, expectTypeOf, it } from "vitest";
import type { ErrorClass } from "../../src/flow/ast.js";
import * as root from "../../src/index.js";
import {
  AGBossError,
  DecisionError,
  ExecutionError,
  LimitError,
  LimitErrorKind,
  Result,
  StepError,
} from "../../src/index.js";
import { StoreError, StoreErrorKind } from "../../src/stores/index.js";

declare const thrown: unknown;

describe("#1325a: a family is a discriminated union", () => {
  it("narrows `unknown` with instanceof, then by kind to the variant's own facts", () => {
    if (!(thrown instanceof LimitError)) return;
    expectTypeOf(thrown).toEqualTypeOf<LimitError>();
    switch (thrown.kind) {
      case LimitErrorKind.Budget:
        expectTypeOf(thrown).toEqualTypeOf<LimitError.Budget>();
        expectTypeOf(thrown.maxSpend).not.toBeAny();
        expectTypeOf(thrown.budget.name).toEqualTypeOf<string>();
        break;
      case LimitErrorKind.Deadline:
        expectTypeOf(thrown.deadlineAt).toEqualTypeOf<Date>();
        break;
      case LimitErrorKind.Items:
        expectTypeOf(thrown.node).toEqualTypeOf<string>();
        expectTypeOf(thrown.actual).toEqualTypeOf<number>();
        break;
      case LimitErrorKind.Steps:
      case LimitErrorKind.Visits:
      case LimitErrorKind.Depth:
      case LimitErrorKind.Hops:
      case LimitErrorKind.MeshLoop:
        expectTypeOf(thrown.limit).toEqualTypeOf<number>();
        break;
      default:
        expectTypeOf(thrown).toBeNever();
    }
  });

  it("`instanceof Family.Variant` narrows to the variant", () => {
    if (thrown instanceof StepError.QualityGate) {
      expectTypeOf(thrown).toEqualTypeOf<StepError.QualityGate>();
      expectTypeOf(thrown.retries).toEqualTypeOf<number>();
      expectTypeOf(thrown.kind).toEqualTypeOf<root.StepErrorKind.QualityGate>();
    }
  });

  it("the code is the variant's literal: `switch (error.code)` narrows", () => {
    expectTypeOf<LimitError.Budget["code"]>().toEqualTypeOf<"limit.budget">();
    expectTypeOf<ExecutionError.LeaseLost["code"]>().toEqualTypeOf<"execution.lease-lost">();
    expectTypeOf<DecisionError["code"]>().toEqualTypeOf<
      "model.decision.invalid-request" | "model.decision.invalid-response"
    >();
    expectTypeOf<LimitError["kind"]>().toEqualTypeOf<LimitErrorKind>();
  });

  it("every variant is an AGBossError; a paid family's carries usage and spend", () => {
    expectTypeOf<LimitError>().toExtend<AGBossError>();
    expectTypeOf<StepError.Agent>().toExtend<AGBossError>();
    expectTypeOf<LimitError.Budget["usage"]>().toEqualTypeOf<readonly root.UsageRecord[]>();
    expectTypeOf<LimitError.Budget["spend"]>().toEqualTypeOf<root.CostReport>();
    expectTypeOf<ExecutionError.UnknownThread>().not.toHaveProperty("usage");
  });
});

describe("#1325a: a family and a variant are error classes", () => {
  it("`.onError` and `toFailWith` take either (`abstract new`)", () => {
    expectTypeOf(LimitError).toExtend<ErrorClass>();
    expectTypeOf(LimitError.Budget).toExtend<ErrorClass>();
    expectTypeOf(StepError).toExtend<ErrorClass>();
    expectTypeOf<InstanceType<typeof LimitError.Budget>>().toEqualTypeOf<LimitError.Budget>();
  });

  it("the family's constructor is abstract: it cannot be made", () => {
    // @ts-expect-error a family is the base of its variants, never made itself
    new LimitError();
  });
});

describe("#1325a: a variant's constructor takes the facts it carries", () => {
  it("the facts are required, `message`, `cause` and `usage` are not", () => {
    const made = new LimitError.Items({ node: "n", limit: 1, actual: 2, path: [], spentUsd: 0 });

    expectTypeOf(made).toEqualTypeOf<LimitError.Items>();
    // @ts-expect-error `limit` and `actual` are facts of the variant
    new LimitError.Items({ node: "n", path: [], spentUsd: 0 });
    // @ts-expect-error a fact the variant does not carry
    new LimitError.Items({ node: "n", limit: 1, actual: 2, path: [], spentUsd: 0, nope: 1 });
  });

  it("a variant with no required fact is made with no argument", () => {
    expectTypeOf(new ExecutionError.UnknownThread()).toEqualTypeOf<ExecutionError.UnknownThread>();
    expectTypeOf(
      new ExecutionError.UnknownThread({ message: "m", cause: 1 }).kind,
    ).toEqualTypeOf<root.ExecutionErrorKind.UnknownThread>();
  });
});

describe("#1325a: StoreError.of is typed by the kind", () => {
  it("gives the variant of the kind it is given", () => {
    const made = StoreError.of(StoreErrorKind.SchemaTooNew, {});

    expectTypeOf(made).toEqualTypeOf<StoreError.SchemaTooNew>();
    expectTypeOf(made.kind).toEqualTypeOf<StoreErrorKind.SchemaTooNew>();
  });
});

describe("#1325a: Result", () => {
  it("is discriminated on `ok`", () => {
    expectTypeOf<Result<number>>().toEqualTypeOf<
      Result.Ok<number> | Result.Err<root.AGBossError>
    >();
    expectTypeOf<Result.Ok<number>["ok"]>().toEqualTypeOf<true>();
    expectTypeOf<Result.Err<Error>["ok"]>().toEqualTypeOf<false>();
  });

  it("Result.try gives a Result for a sync call and a promise of one for an async call", () => {
    expectTypeOf(Result.try(() => 1)).toEqualTypeOf<Result<number>>();
    expectTypeOf(Result.try(async () => Promise.resolve(1))).toEqualTypeOf<
      Promise<Result<number>>
    >();
  });
});

describe("#1325a: the removed forms are gone", () => {
  it("the old DecisionError classes are the family's variants now", () => {
    // @ts-expect-error `DecisionRequestError` is `DecisionError.InvalidRequest`
    expectTypeOf(root.DecisionRequestError).toBeUnknown();
    // @ts-expect-error `DecisionResponseError` is `DecisionError.InvalidResponse`
    expectTypeOf(root.DecisionResponseError).toBeUnknown();
    expectTypeOf(DecisionError.InvalidRequest).toBeConstructibleWith({ message: "m" });
  });
});
