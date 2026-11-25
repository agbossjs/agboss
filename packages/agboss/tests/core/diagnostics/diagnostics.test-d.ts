/**
 * #1325c, at compile time: what an error reports about itself, and the mesh errors' `chain` field
 * that became `callChain` so `chain()` is the method on every error.
 */
import { LimitError } from "../../../src/core/error-families/limit-errors.js";
import { describe, expectTypeOf, it } from "vitest";
import {
  AGBossError,
  BacktraceMode,
  ValidationError,
  type ErrorFormatOptions,
  type ExecutionSpanFrame,
  type LabeledSpan,
  type SourceSpan,
} from "../../../src/index.js";

describe("#1325c: what an error reports about itself", () => {
  it("every error has the report's facts and methods", () => {
    expectTypeOf<AGBossError["location"]>().toEqualTypeOf<SourceSpan | undefined>();
    expectTypeOf<AGBossError["secondarySpans"]>().toEqualTypeOf<readonly LabeledSpan[]>();
    expectTypeOf<AGBossError["spanTrace"]>().toEqualTypeOf<readonly ExecutionSpanFrame[]>();
    expectTypeOf<AGBossError["notes"]>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<AGBossError["help"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<AGBossError["suggestionPatch"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<AGBossError["chain"]>().toEqualTypeOf<() => readonly Error[]>();
    expectTypeOf<AGBossError["format"]>().toEqualTypeOf<(options?: ErrorFormatOptions) => string>();
  });

  it("a variant's constructor takes the report's facts beside its own", () => {
    const error = new ValidationError.TenantRequired({
      operation: "execute",
      help: "pass tenantId",
      notes: ["n"],
    });

    expectTypeOf(error.help).toEqualTypeOf<string | undefined>();
  });

  it("the backtrace mode is closed", () => {
    expectTypeOf<`${BacktraceMode}`>().toEqualTypeOf<"0" | "1" | "full">();
    expectTypeOf<ErrorFormatOptions["backtrace"]>().toEqualTypeOf<BacktraceMode | undefined>();
  });
});

describe("#1325c: the mesh limits' call chain", () => {
  it("is callChain; the old `chain` option is gone, so chain() is the method everywhere", () => {
    expectTypeOf<LimitError.MeshLoop["callChain"]>().not.toBeAny();
    expectTypeOf<LimitError.Hops["chain"]>().toEqualTypeOf<() => readonly Error[]>();
    const stale: ConstructorParameters<typeof LimitError.MeshLoop>[0] = {
      entry: "a › s",
      meshEntry: { application: "a", start: "s" },
      callChain: [],
      // @ts-expect-error the option `chain` is renamed `callChain`
      chain: [],
    };
    expectTypeOf(stale).not.toBeAny();
  });
});
