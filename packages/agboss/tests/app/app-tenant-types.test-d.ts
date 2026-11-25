import { describe, expectTypeOf, it } from "vitest";
import type {
  App,
  ExecutionHistoryRecord,
  ExecutionsQuery,
  HasTenantContext,
  Page,
  TenantContextBranded,
} from "../../src/index.js";
import type { ChatApplication } from "../flow/fixtures/chat.fixture.js";
import type { ClinicApplication } from "../flow/fixtures/clinic.fixture.js";

/**
 * #1324e: `App<TApp>` asks for the tenant in its types per its application's brand: optional with
 * `false` (the one tenant `"default"`), required with `true`, and required too when the brand is
 * unknown (fail-safe: never silently the default tenant).
 */

declare const plain: App<TenantContextBranded<false>>;
declare const tenanted: App<TenantContextBranded<true>>;
declare const unbranded: App;

describe("App<TApp> without a tenantContext", () => {
  it("every point call and listing may omit the tenant", () => {
    void plain.cancel("t");
    void plain.cancel("t", { tenantId: "acme" });
    void plain.resume({ pauseId: "p", decision: {} });
    void plain.extendPause({ pauseId: "p", expiresIn: 1000 as never });
    void plain.getExecution("e");
    void plain.listExecutions();
    void plain.listExecutions({ limit: 5, workflow: "w" });
    void plain.listExecutions({ tenantId: "acme" });
  });
});

describe("App<TApp> with a tenantContext, or one not branded", () => {
  it("a point call without its tenant does not compile", () => {
    // @ts-expect-error — the application declares a tenantContext: name the tenant
    void tenanted.cancel("t");
    // @ts-expect-error — options without a tenantId
    void tenanted.cancel("t", { ownerId: "o" });
    // @ts-expect-error — a resume names its tenant
    void tenanted.resume({ pauseId: "p", decision: {} });
    // @ts-expect-error — an extension names its tenant
    void tenanted.extendPause({ pauseId: "p", expiresIn: 1000 as never });
    // @ts-expect-error — a reassignment names its tenant
    void tenanted.reassignPause({ pauseId: "p", assignee: "d" });
    // @ts-expect-error — a read names its tenant
    void tenanted.getExecution("e");
    void tenanted.cancel("t", { tenantId: "acme" });
    void tenanted.getExecution("e", { tenantId: "acme" });
    void tenanted.resume({ pauseId: "p", decision: {} }, { tenantId: "acme", ownerId: "o" });
  });

  it("a listing names one tenant or allTenants, never both and never neither", () => {
    // @ts-expect-error — neither a tenant nor allTenants
    void tenanted.listExecutions();
    // @ts-expect-error — a query without a scope
    void tenanted.listExecutions({ limit: 5 });
    // @ts-expect-error — both a tenant and allTenants
    void tenanted.listExecutions({ tenantId: "acme", allTenants: true });
    void tenanted.listExecutions({ tenantId: "acme", limit: 5 });
    void tenanted.listExecutions({ allTenants: true });
  });

  it("an application not branded (not generated yet) counts as tenanted", () => {
    // @ts-expect-error — fail-safe: no brand, so the tenant is required
    void unbranded.cancel("t");
    // @ts-expect-error — fail-safe, for a listing too
    void unbranded.listExecutions();
    void unbranded.cancel("t", { tenantId: "default" });
  });
});

describe("App's reads", () => {
  it("return the kept record, or a page of them", () => {
    expectTypeOf(plain.getExecution("e")).toEqualTypeOf<
      Promise<ExecutionHistoryRecord | undefined>
    >();
    expectTypeOf(plain.listExecutions()).toEqualTypeOf<Promise<Page<ExecutionHistoryRecord>>>();
    expectTypeOf<ExecutionsQuery["limit"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<ExecutionsQuery["startedAfter"]>().toEqualTypeOf<Date | string | undefined>();
  });
});

/** The brand `.agboss/types.d.ts` generates on each `@Application` class (#1324e), read by `createApp`. */
declare const generatedPlain: App<ChatApplication>;
declare const generatedTenanted: App<ClinicApplication>;

describe("App<TApp> of a generated application", () => {
  it("one without a tenantContext: resume and execute leave the tenant out", () => {
    void generatedPlain.resume({ pauseId: "p", decision: {} });
    void generatedPlain.cancel("t");
    void generatedPlain.listExecutions();
    expectTypeOf<HasTenantContext<ChatApplication>>().toEqualTypeOf<false>();
  });

  it("one with a tenantContext: the tenant is required", () => {
    // @ts-expect-error — the application declares a tenantContext: name the tenant
    void generatedTenanted.resume({ pauseId: "p", decision: {} });
    void generatedTenanted.resume({ pauseId: "p", decision: {} }, { tenantId: "acme" });
    expectTypeOf<HasTenantContext<ClinicApplication>>().toEqualTypeOf<true>();
  });
});
