import { describe, expectTypeOf, it } from "vitest";
import type * as Root from "../../src/index.js";
import type * as Units from "../../src/units/index.js";
import type * as Internal from "../../src/internal.js";
import type * as DeprecatedCore from "../../src/core/index.js";
import type { AppOptions, ApplicationOptions, RetentionOptions } from "../../src/index.js";

/**
 * #834 — the application's configuration (0.1.1 API review G2): one retention group, `createApp`'s
 * four options, the assembly internals in `/internal` and the units in `/units` only.
 */

describe("#834 AC1: one retention group", () => {
  it("the old retention options do not compile", () => {
    expectTypeOf<ApplicationOptions>().not.toHaveProperty("pauseRecordRetention");
    expectTypeOf<ApplicationOptions>().not.toHaveProperty("executionRecordRetention");
    expectTypeOf<ApplicationOptions>().not.toHaveProperty("leaseEventRetention");
    expectTypeOf<ApplicationOptions>().not.toHaveProperty("ledgerEntryRetention");
    expectTypeOf<ApplicationOptions>().not.toHaveProperty("a2a");
    expectTypeOf<NonNullable<ApplicationOptions["fencedEffects"]>>().not.toHaveProperty(
      "retention",
    );
    expectTypeOf<NonNullable<ApplicationOptions["outboundCalls"]>>().not.toHaveProperty(
      "retention",
    );
    expectTypeOf<NonNullable<ApplicationOptions["mesh"]>>().not.toHaveProperty(
      "idempotencyRetention",
    );
  });

  it("the group has exactly its fields, each a Milliseconds", () => {
    expectTypeOf<ApplicationOptions["retention"]>().toEqualTypeOf<RetentionOptions | undefined>();
    expectTypeOf<keyof RetentionOptions>().toEqualTypeOf<
      | "pauseRecords"
      | "executionRecords"
      | "leaseEvents"
      | "costLedgerEntries"
      | "fencedEffects"
      | "outboundCalls"
      | "meshAnswers"
      | "a2aTasks"
    >();
    expectTypeOf<
      Required<RetentionOptions>[keyof RetentionOptions]
    >().toEqualTypeOf<Units.Milliseconds>();
  });
});

describe("#834 AC4: createApp takes env, profile, profileRoot and meterProvider only", () => {
  it("its options are those four", () => {
    expectTypeOf<keyof AppOptions>().toEqualTypeOf<
      "env" | "profile" | "profileRoot" | "meterProvider"
    >();
  });

  it("the seams are on the internal build path", () => {
    expectTypeOf<Internal.BuildApplicationOptions>().toHaveProperty("processEnv");
    expectTypeOf<Internal.BuildApplicationOptions>().toHaveProperty("gateway");
    expectTypeOf<Internal.BuildApplicationOptions>().toHaveProperty("providerFetch");
    expectTypeOf<Internal.BuildApplicationOptions>().toHaveProperty("transport");
    expectTypeOf<Internal.BuildApplicationOptions>().toHaveProperty("connectMcp");
    expectTypeOf<Internal.BuildApplicationOptions>().toHaveProperty("container");
    expectTypeOf<Internal.BuildApplicationOptions>().toHaveProperty("branchScheduler");
  });
});

describe("#834 AC5: internals in /internal, units in /units", () => {
  it("the assembly internals are not in the root, nor in the deprecated /core", () => {
    expectTypeOf<typeof Root>().not.toHaveProperty("createAppDeps");
    expectTypeOf<typeof Root>().not.toHaveProperty("ExecutionObserverManager");
    expectTypeOf<typeof DeprecatedCore>().not.toHaveProperty("ExecutionObserverManager");
    expectTypeOf<typeof Internal>().toHaveProperty("createAppDeps");
    expectTypeOf<typeof Internal>().toHaveProperty("ExecutionObserverManager");
    expectTypeOf<typeof Internal>().toHaveProperty("createAppWith");
  });

  it("the moved types come from /internal only", () => {
    // @ts-expect-error — AppDeps is internal
    expectTypeOf<Root.AppDeps>().toBeObject();
    // @ts-expect-error — AppDepsOptions is internal
    expectTypeOf<Root.AppDepsOptions>().toBeObject();
    // @ts-expect-error — McpConnect is internal
    expectTypeOf<Root.McpConnect>().toBeFunction();
    // @ts-expect-error — GraphDeps is internal
    expectTypeOf<Root.GraphDeps<string>>().toBeObject();
    expectTypeOf<Internal.AppDeps>().toBeObject();
    expectTypeOf<Internal.GraphDeps<string>>().toBeObject();
  });

  it("Usd, Milliseconds and Bytes have one home, /units", () => {
    // @ts-expect-error — a unit comes from @agboss/core/units
    expectTypeOf<Root.Usd>().toBeNumber();
    // @ts-expect-error — a unit comes from @agboss/core/units
    expectTypeOf<Root.Milliseconds>().toBeNumber();
    // @ts-expect-error — a unit comes from @agboss/core/units
    expectTypeOf<Root.Bytes>().toBeNumber();
    expectTypeOf<Units.Usd>().toExtend<number>();
    expectTypeOf<Units.Milliseconds>().toExtend<number>();
    expectTypeOf<Units.Bytes>().toExtend<number>();
  });
});
