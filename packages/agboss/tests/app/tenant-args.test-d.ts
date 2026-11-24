import { describe, expectTypeOf, it } from "vitest";
import type {
  HasTenantContext,
  Page,
  PageQuery,
  TenantContextBranded,
  TenantListArgs,
  TenantPointArgs,
} from "../../src/index.js";
import type { Page as StoresPage, PageQuery as StoresPageQuery } from "../../src/stores/index.js";

declare class Single {
  readonly marker: 1;
}
type Plain = TenantContextBranded<false>;
type Tenanted = TenantContextBranded<true>;

interface Opts {
  readonly reason?: string;
}
interface Query {
  readonly limit?: number;
}

describe("paging types (#1324e)", () => {
  it("PageQuery and Page have one shape, re-exported in stores", () => {
    expectTypeOf<PageQuery>().toEqualTypeOf<{
      readonly cursor?: string;
      readonly limit?: number;
    }>();
    expectTypeOf<Page<number>>().toEqualTypeOf<{
      readonly items: readonly number[];
      readonly nextCursor?: string;
    }>();
    expectTypeOf<StoresPage<string>>().toEqualTypeOf<Page<string>>();
    expectTypeOf<StoresPageQuery>().toEqualTypeOf<PageQuery>();
  });
});

describe("HasTenantContext (#1324e)", () => {
  it("is false only for a brand that says false; fail-safe true otherwise", () => {
    expectTypeOf<HasTenantContext<Plain>>().toEqualTypeOf<false>();
    expectTypeOf<HasTenantContext<Tenanted>>().toEqualTypeOf<true>();
    expectTypeOf<HasTenantContext<unknown>>().toEqualTypeOf<true>();
    expectTypeOf<HasTenantContext<any>>().toEqualTypeOf<true>();
    expectTypeOf<HasTenantContext<Single>>().toEqualTypeOf<true>();
    expectTypeOf<HasTenantContext<TenantContextBranded<boolean>>>().toEqualTypeOf<true>();
  });
});

describe("TenantPointArgs (#1324e)", () => {
  it("is optional without a tenantContext", () => {
    expectTypeOf<TenantPointArgs<Plain, Opts>>().toEqualTypeOf<
      [options?: Opts & { readonly tenantId?: string }]
    >();
    const noop = (..._args: TenantPointArgs<Plain, Opts>): void => undefined;
    noop();
    noop({ tenantId: "t1", reason: "x" });
  });

  it("is required, with tenantId, with a tenantContext or an unknown app", () => {
    const tenanted = (..._args: TenantPointArgs<Tenanted, Opts>): void => undefined;
    // @ts-expect-error a tenanted app's point call names its tenant
    tenanted();
    // @ts-expect-error the options need the tenantId
    tenanted({ reason: "x" });
    tenanted({ tenantId: "t1" });
    const unknownApp = (..._args: TenantPointArgs<unknown>): void => undefined;
    // @ts-expect-error fail-safe: an unknown app requires the tenant
    unknownApp();
    unknownApp({ tenantId: "t1" });
  });
});

describe("TenantListArgs (#1324e)", () => {
  it("is optional without a tenantContext", () => {
    const list = (..._args: TenantListArgs<Plain, Query>): void => undefined;
    list();
    list({ limit: 5 });
    list({ tenantId: "t1" });
  });

  it("takes one tenantId or allTenants: true, never both, with a tenantContext", () => {
    const list = (..._args: TenantListArgs<Tenanted, Query>): void => undefined;
    // @ts-expect-error the listing needs a scope
    list();
    // @ts-expect-error a query without a scope
    list({ limit: 5 });
    list({ tenantId: "t1", limit: 5 });
    list({ allTenants: true });
    // @ts-expect-error both at once
    list({ tenantId: "t1", allTenants: true });
    // @ts-expect-error allTenants is only ever true
    list({ allTenants: false });
  });
});
