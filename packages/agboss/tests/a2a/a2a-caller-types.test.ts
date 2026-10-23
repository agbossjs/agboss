/**
 * #387 S2 Q1: a caller is typed by the start's application — with a declared `TenantContext` the
 * tenant's values are required, so a single-tenant `resolved({})` does not compile there; an
 * answer is built only by `A2ACallerResolution`.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  A2ACallerResolution,
  A2ACallerResolutionKind,
  type A2ACaller,
  type A2ACallerResolver,
} from "../../src/a2a/index.js";
import type { BedRequestWorkflowStart } from "../flow/fixtures/clinic.fixture.js";
import type { TenantAskStart } from "./fixtures/tenant-desk.workflow.js";

type ClinicStart = typeof BedRequestWorkflowStart;

describe("#387: the caller is typed by the start's application", () => {
  it("with a declared TenantContext, resolved({}) does not compile; its values do", () => {
    // @ts-expect-error — the clinic declares ClinicTenantContext: its tenant is required
    const single: A2ACallerResolution<ClinicStart> = A2ACallerResolution.resolved({});
    const tenant = { tenantId: "north", units: [{ unitId: "u-1", name: "Ward 1" }] };
    const execution = { clinician: { clinicianId: "c-1" }, unitId: "u-1" };
    const known: A2ACallerResolution<ClinicStart> = A2ACallerResolution.resolved({
      tenant,
      execution,
      ownerId: "c-1",
    });

    expect([single.kind, known.kind]).toEqual([
      A2ACallerResolutionKind.Resolved,
      A2ACallerResolutionKind.Resolved,
    ]);
    expectTypeOf<A2ACaller<ClinicStart>["tenant"]>().not.toBeUndefined();
  });

  it("without declared contexts, resolved({}) is the single-tenant answer", () => {
    const resolution: A2ACallerResolution<typeof TenantAskStart> = A2ACallerResolution.resolved({});

    expect(resolution).toEqual({ kind: A2ACallerResolutionKind.Resolved, caller: {} });
  });

  it("a plain object is not an answer", () => {
    const resolver: A2ACallerResolver<typeof TenantAskStart> = {
      // @ts-expect-error — not built by A2ACallerResolution: no brand
      resolveCaller: () => ({ kind: A2ACallerResolutionKind.Resolved, caller: {} }),
    };
    const forbidden = A2ACallerResolution.forbidden({ reason: "no" });

    expect(typeof resolver.resolveCaller).toBe("function");
    expect(Object.isFrozen(forbidden)).toBe(true);
  });
});
