import { describe, expectTypeOf, it } from "vitest";
import type * as Root from "../../src/index.js";
import type * as Units from "../../src/units/index.js";
import type * as Internal from "../../src/internal.js";
import type * as DeprecatedCore from "../../src/core/index.js";
import type { TracerProvider } from "@opentelemetry/api";
import type {
  CreateAppOptions,
  ApplicationOptions,
  RetentionOptions,
  TraceLinkContext,
  TracingAdapter,
} from "../../src/index.js";

/**
 * #834 — the application's configuration (0.1.1 API review G2): one retention group, `createApp`'s
 * four options, the assembly internals in `/internal` and the units in `/units` only.
 */

describe("#834 AC1: one retention group", () => {
  it("the old retention options do not compile", () => {
    expectTypeOf<ApplicationOptions>().not.toHaveProperty("pauseRecordRetention");
    expectTypeOf<ApplicationOptions>().not.toHaveProperty("executionRecordRetention");
    expectTypeOf<ApplicationOptions>().not.toHaveProperty("auditLogRetention");
    expectTypeOf<ApplicationOptions>().not.toHaveProperty("ledgerEntryRetention");
    expectTypeOf<ApplicationOptions>().not.toHaveProperty("a2a");
    // #1317: the settings of fenced effects and outbound calls are options of each call now
    expectTypeOf<ApplicationOptions>().not.toHaveProperty("fencedEffects");
    expectTypeOf<ApplicationOptions>().not.toHaveProperty("outboundCalls");
    expectTypeOf<ApplicationOptions>().not.toHaveProperty("idempotencyKeyField");
    expectTypeOf<ApplicationOptions>().not.toHaveProperty("previousIdempotencyKeyField");
    expectTypeOf<NonNullable<ApplicationOptions["mesh"]>>().not.toHaveProperty(
      "idempotencyRetention",
    );
  });

  it("the group has exactly its fields, each a Milliseconds", () => {
    expectTypeOf<ApplicationOptions["retention"]>().toEqualTypeOf<RetentionOptions | undefined>();
    expectTypeOf<keyof RetentionOptions>().toEqualTypeOf<
      "pauseRecords" | "executionRecords" | "auditLog" | "costLedgerEntries"
    >();
    expectTypeOf<
      Required<RetentionOptions>[keyof RetentionOptions]
    >().toEqualTypeOf<Units.Milliseconds>();
  });
});

describe("#834 AC4 / #1324f / #1324e: createApp takes env, profile, the providers, handleSignals and processEnv only", () => {
  it("its options are those six", () => {
    expectTypeOf<keyof CreateAppOptions>().toEqualTypeOf<
      "env" | "profile" | "meterProvider" | "tracerProvider" | "handleSignals" | "processEnv"
    >();
    expectTypeOf<CreateAppOptions["handleSignals"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<CreateAppOptions["processEnv"]>().toEqualTypeOf<NodeJS.ProcessEnv | undefined>();
  });

  it("#1324f: tracerProvider is an OpenTelemetry TracerProvider or a TracingAdapter", () => {
    expectTypeOf<CreateAppOptions["tracerProvider"]>().toEqualTypeOf<
      TracerProvider | TracingAdapter | undefined
    >();
    expectTypeOf<TracingAdapter["tracerProvider"]>().toEqualTypeOf<TracerProvider>();
    expectTypeOf<TraceLinkContext>().toEqualTypeOf<{
      readonly workflow: string;
      readonly threadId: string;
      readonly runId: string;
      readonly tenantId: string;
    }>();
  });

  it("#1324f: AppOptions is gone", () => {
    // @ts-expect-error -- renamed to CreateAppOptions
    type Gone = Root.AppOptions;
    expectTypeOf<Gone>().toBeAny();
  });

  it("#1318d1: profile is one name, a comma/plus list, or a list of names — profileRoot is gone", () => {
    expectTypeOf<CreateAppOptions["profile"]>().toEqualTypeOf<
      string | readonly string[] | undefined
    >();
    // @ts-expect-error -- profiles live in src/config next to the application file, not under a root
    const rooted: CreateAppOptions = { profileRoot: "." };
    expectTypeOf(rooted).toBeObject();
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
