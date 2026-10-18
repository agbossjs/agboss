/**
 * #261 PR 3 — the context levels: `ApplicationContext` → `TenantContext` → `ExecutionContext`, each
 * linking up; the project's subclasses declared in `@Application({ tenantContext, executionContext })`
 * and injected; their values passed per execution, validated before the first step, frozen and
 * kept by a resume; the default tenant; threads keyed by tenant + thread.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { App } from "../../src/app/types.js";
import { createApp } from "../../src/application/create-app.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import {
  ExecutionContextUnavailableError,
  NotPausedError,
  TenantContext,
  UnknownThreadError,
} from "../../src/index.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import {
  BedAgent,
  BedRequestWorkflowStart,
  BedsDto,
  BookBedTool,
  ClinicApplication,
  ClinicTenantContext,
  clinicSeen,
  FreeBedsTool,
  resetClinicSeen,
  UnitDirectoryService,
} from "../flow/fixtures/clinic.fixture.js";
import { execute } from "../helpers/flow.js";

const test = testWith(ClinicApplication);

const haifa = { tenantId: "haifa-clinic", units: [{ unitId: "icu", name: "Intensive care" }] };
const levi = { clinician: { clinicianId: "c-12" }, unitId: "icu" };
const approve = { approved: true, by: "dana" };

beforeEach(resetClinicSeen);

describe("#261 AC4: the levels link up; the project's subclasses are declared and injected", () => {
  test("a tool reads its execution, its tenant and the application through one object", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(BedAgent).thenReturn(
      callTool(FreeBedsTool, { ward: "icu" }),
      replyWith(BedsDto, { text: "2 beds" }),
    );

    const result = await app.execute(
      BedRequestWorkflowStart,
      { text: "a bed for room 4" },
      { tenant: haifa, execution: levi },
    );

    expect(result.tenantId).toBe("haifa-clinic");
    expect(clinicSeen.readings[0]).toEqual({
      tenantId: "haifa-clinic",
      weight: 1,
      unitName: "Intensive care",
      clinicianId: "c-12",
      applicationName: "clinic-application",
      sameTenant: true,
    });
  });

  test("the base tokens give the declared levels: one tenant object, frozen, linked to the one application", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(BedAgent).thenReturn(replyWith(BedsDto, { text: "none" }));

    await app.execute(
      BedRequestWorkflowStart,
      { text: "a bed" },
      { tenant: { ...haifa, weight: 3 }, execution: levi },
    );

    const [tenant] = clinicSeen.tenants;
    expect(tenant).toBeInstanceOf(ClinicTenantContext);
    expect(tenant).toBeInstanceOf(TenantContext);
    expect(clinicSeen.readings[0]).toMatchObject({ weight: 3, sameTenant: true });
  });

  it("outside an execution a read throws, naming the consumer and the field — never undefined", async () => {
    const app = await createApp(ClinicApplication, {
      processEnv: {},
      gateway: createScriptedGateway(new ScriptBook()),
    });
    const directory = app.resolve(UnitDirectoryService);

    expect(() => directory.unitName("icu")).toThrow(ExecutionContextUnavailableError);
    expect(() => directory.unitName("icu")).toThrow(
      "UnitDirectoryService read tenantContext.units outside an execution",
    );
    await app.close();
  });
});

describe("#261 AC4: the values are validated before the first step and frozen", () => {
  test("an invalid value is dto.invalid and onRunRejected: the field named, never the value", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(BedAgent).thenReturn(replyWith(BedsDto, { text: "never" }));
    const tenant = { tenantId: "haifa-clinic", units: [{ unitId: 4711, name: "ICU" }] };

    const refused = execute(
      app,
      BedRequestWorkflowStart,
      { text: "a bed" },
      {
        tenant,
        execution: levi,
      },
    );

    await expect(refused).rejects.toMatchObject({ code: "dto.invalid" });
    await expect(refused).rejects.toThrow(/units\[0\]\.unitId/);
    await expect(refused).rejects.not.toThrow(/4711/);
    expect(clinicSeen.rejections).toMatchObject([{ operation: "execute", code: "dto.invalid" }]);
    expect(clinicSeen.rejections[0]?.message).not.toContain("4711");
    expect(mockLlm(BedAgent).requests).toHaveLength(0);
  });

  test("a missing execution field, a weight that is not a positive integer: rejected", async ({
    app,
  }) => {
    const noUnit = { clinician: { clinicianId: "c-12" } };

    await expect(
      execute(app, BedRequestWorkflowStart, { text: "a" }, { tenant: haifa, execution: noUnit }),
    ).rejects.toThrow(/invalid ClinicExecutionContext: unitId/);
    await expect(
      execute(
        app,
        BedRequestWorkflowStart,
        { text: "a" },
        {
          tenant: { ...haifa, weight: 0 },
          execution: levi,
        },
      ),
    ).rejects.toThrow(/invalid ClinicTenantContext: weight/);
  });

  test("frozen: the tenant and everything in it; the caller's own object is not touched", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(BedAgent).thenReturn(replyWith(BedsDto, { text: "none" }));
    const tenant = { tenantId: "haifa-clinic", units: [{ unitId: "icu", name: "ICU" }] };

    await app.execute(BedRequestWorkflowStart, { text: "a bed" }, { tenant, execution: levi });

    const [seenTenant] = clinicSeen.tenants;
    expect(Object.isFrozen(seenTenant)).toBe(true);
    expect(Object.isFrozen((seenTenant as ClinicTenantContext).units[0])).toBe(true);
    expect(Object.isFrozen(tenant.units[0])).toBe(false);
  });

  test("a resume runs on the values the execution started with; it takes only the tenant's id", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(BedAgent).thenReturn(
      callTool(BookBedTool, { ward: "icu" }),
      replyWith(BedsDto, { text: "booked" }),
    );
    const paused = await app.execute(
      BedRequestWorkflowStart,
      { text: "book a bed" },
      { tenant: haifa, execution: levi },
    );

    const done = await app.resume(paused.threadId, approve, { tenantId: "haifa-clinic" });

    expect(done.output).toEqual({ text: "booked" });
    expect(clinicSeen.readings[0]).toMatchObject({ tenantId: "haifa-clinic", clinicianId: "c-12" });
  });
});

describe("#261 AC5: the default tenant; a thread's key is tenant + thread", () => {
  test("no tenantId passed → the tenant 'default'", async ({ app, mockLlm }) => {
    mockLlm(BedAgent).thenReturn(replyWith(BedsDto, { text: "none" }));

    const result = await app.execute(
      BedRequestWorkflowStart,
      { text: "a bed" },
      { tenant: { units: [] }, execution: levi },
    );

    expect(result.tenantId).toBe("default");
    expect(clinicSeen.readings[0]).toMatchObject({ tenantId: "default", weight: 1 });
  });

  test("another tenant's thread does not exist for the caller: execute and cancel", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(BedAgent).thenReturn(replyWith(BedsDto, { text: "none" }));
    const first = await app.execute(
      BedRequestWorkflowStart,
      { text: "a bed" },
      { tenant: haifa, execution: levi },
    );
    const telAviv = { tenantId: "tel-aviv-clinic", units: [] };

    const continued = app.execute(
      BedRequestWorkflowStart,
      { text: "again" },
      { threadId: first.threadId, tenant: telAviv, execution: levi },
    );

    await expect(continued).rejects.toBeInstanceOf(UnknownThreadError);
    await expect(continued).rejects.not.toThrow(/haifa/);
    await expect(
      app.cancel(first.threadId, { tenantId: "tel-aviv-clinic" }),
    ).rejects.toBeInstanceOf(UnknownThreadError);
    expect(await app.cancel(first.threadId, { tenantId: "haifa-clinic" })).toEqual({
      cancelled: false,
    });
  });

  test("another tenant cannot resume a pause; its own tenant does", async ({ app, mockLlm }) => {
    mockLlm(BedAgent).thenReturn(
      callTool(BookBedTool, { ward: "icu" }),
      replyWith(BedsDto, { text: "booked" }),
    );
    const paused = await app.execute(
      BedRequestWorkflowStart,
      { text: "book" },
      { tenant: haifa, execution: levi },
    );

    await expect(app.resume(paused.threadId, approve)).rejects.toBeInstanceOf(NotPausedError);
    await expect(
      app.resume(paused.threadId, approve, { tenantId: "tel-aviv-clinic" }),
    ).rejects.toBeInstanceOf(NotPausedError);
    const done = await app.resume(paused.threadId, approve, { tenantId: "haifa-clinic" });
    expect(done.tenantId).toBe("haifa-clinic");
  });
});

/** Compile-time checks (tsc): the options are typed by the start's application. */
export function typedOptions(app: App): void {
  // @ts-expect-error — the clinic declares its contexts: their values are required
  void app.execute(BedRequestWorkflowStart, { text: "a" });
  // @ts-expect-error — `execution` must be ClinicExecutionContext's values
  void app.execute(BedRequestWorkflowStart, { text: "a" }, { tenant: haifa, execution: {} });
  void app.execute(BedRequestWorkflowStart, { text: "a" }, { tenant: haifa, execution: levi });
}
