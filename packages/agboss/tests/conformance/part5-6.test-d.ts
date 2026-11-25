import { describe, expectTypeOf, it } from "vitest";
import type { ApplicationExecutionLimits, ApplicationOptions } from "../../src/index.js";
import type { CostLine, TokenUsage, UsageRecord } from "../../src/finops/usage.js";
import type { ModelEndEvent, ModelStartEvent } from "../../src/core/observability.js";
import type { EvalModelCallTrace } from "../../src/eval/index.js";
import type { EnvReaders } from "../../src/environments/env-readers.js";
import type { EnvRef } from "../../src/environments/env-ref.js";
import type { Milliseconds, Ttl } from "../../src/units/index.js";
import type { CliInvocation, ModelProviderResponse } from "../../src/models/index.js";
import type { HeaderSecretTemplate } from "../../src/index.js";
import type * as Models from "../../src/models/index.js";
import type * as Units from "../../src/units/index.js";
import type * as Environments from "../../src/environments/index.js";
import type { McpSessionOptions } from "../../src/mcp/index.js";
import { ResumeDecision, type IncompatibleResumePolicy } from "../../src/index.js";
import type { ConfigError } from "../../src/index.js";
import { CliModelProvider } from "../../src/models/index.js";

/**
 * The DSL-review conformance decisions of parts 5 and 6 (#1311, #1313, #1314, #1318, #1319, #1324):
 * each removed form is pinned as gone, each new form as it is.
 */
describe("#1311: one usage type", () => {
  it("a provider's answer carries the canonical TokenUsage, and ModelProviderUsage is gone", () => {
    expectTypeOf<ModelProviderResponse["usage"]>().toEqualTypeOf<TokenUsage>();
    // @ts-expect-error ModelProviderUsage is removed: the answer's usage is TokenUsage
    expectTypeOf<Models.ModelProviderUsage>().toBeObject();
  });
});

describe("#1313: provider attribution, the CLI provider's contract", () => {
  it("provider is required on a record, a line, both model events and an eval trace", () => {
    expectTypeOf<UsageRecord["provider"]>().toEqualTypeOf<string>();
    expectTypeOf<CostLine["provider"]>().toEqualTypeOf<string>();
    expectTypeOf<ModelStartEvent["provider"]>().toEqualTypeOf<string>();
    expectTypeOf<ModelEndEvent["provider"]>().toEqualTypeOf<string>();
    expectTypeOf<EvalModelCallTrace["provider"]>().toEqualTypeOf<string>();
  });

  it("CliInvocation keeps env and cwd and has no inheritEnvironment", () => {
    expectTypeOf<CliInvocation["env"]>().toEqualTypeOf<
      Readonly<Record<string, string>> | undefined
    >();
    expectTypeOf<CliInvocation["cwd"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<CliInvocation>().not.toHaveProperty("inheritEnvironment");
  });

  it("the hook is buildCommand; a subclass overriding invocationOf is refused", () => {
    class Current extends CliModelProvider {
      protected override buildCommand(): CliInvocation {
        return { command: "x", args: [] };
      }
    }
    // @ts-expect-error invocationOf is no longer the abstract hook: buildCommand is missing
    class Old extends CliModelProvider {
      protected invocationOf(): CliInvocation {
        return { command: "x", args: [] };
      }
    }
    expectTypeOf<Current>().toBeObject();
    expectTypeOf<Old>().toBeObject();
  });
});

describe("#1314: unit errors are the family's", () => {
  it("UnitError and PlainErrorOptions are not exported from /units", () => {
    // @ts-expect-error UnitError is removed: a unit out of range is ConfigError.Unit
    expectTypeOf<Units.UnitError>().toBeObject();
    expectTypeOf<ConfigError.Unit["code"]>().toEqualTypeOf<"config.unit">();
  });
});

describe("#1318: env.ttl.optional keeps Ttl.None out unless it allows it", () => {
  const ttl = {} as EnvReaders["ttl"];

  it("allowNone defaults to false", () => {
    expectTypeOf(ttl.optional("A")).toEqualTypeOf<EnvRef<Milliseconds | Ttl.Forever | undefined>>();
    expectTypeOf(ttl.optional("A", { allowNone: false })).toEqualTypeOf<
      EnvRef<Milliseconds | Ttl.Forever | undefined>
    >();
    expectTypeOf(ttl.optional("A", { allowNone: true })).toEqualTypeOf<
      EnvRef<Milliseconds | Ttl | undefined>
    >();
  });
});

describe("#1319: the header secret template and the MCP session", () => {
  it("bearer() returns HeaderSecretTemplate; BearerAuth is gone", () => {
    // @ts-expect-error BearerAuth is renamed
    expectTypeOf<Environments.BearerAuth>().toBeObject();
    expectTypeOf<HeaderSecretTemplate["kind"]>().toEqualTypeOf<"bearer">();
  });

  it("a session names the owner, tenant and execution — never a peer", () => {
    expectTypeOf<McpSessionOptions>().not.toHaveProperty("peer");
    expectTypeOf<keyof McpSessionOptions>().toEqualTypeOf<"ownerId" | "tenant" | "execution">();
  });
});

describe("#1324: execution limits, ResumeDecision", () => {
  it("childClaimTimeout lives in executionLimits, not flat on the application", () => {
    expectTypeOf<ApplicationOptions["executionLimits"]>().toEqualTypeOf<
      ApplicationExecutionLimits | undefined
    >();
    expectTypeOf<ApplicationExecutionLimits>().toHaveProperty("childClaimTimeout");
    expectTypeOf<ApplicationOptions>().not.toHaveProperty("childClaimTimeout");
  });

  it("ResumeDecision is an enum, a policy returns it", () => {
    expectTypeOf(ResumeDecision.Resume).toExtend<ResumeDecision>();
    expectTypeOf<ReturnType<IncompatibleResumePolicy>>().toEqualTypeOf<ResumeDecision>();
    // @ts-expect-error a bare string is no ResumeDecision
    const policy: IncompatibleResumePolicy = () => "resume";
    expectTypeOf(policy).toBeFunction();
  });
});
