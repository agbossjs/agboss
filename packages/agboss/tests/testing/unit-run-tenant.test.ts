/**
 * #1328: `app.runTool` / `runAction` / `runAgent` / `runRouter` give a `UnitRun` (`output`, `spend`)
 * and, in an application that declares a `tenantContext`, need a tenant — the call's own, else the
 * suite's (`testWith(App, { tenant })`): with neither, `ValidationError.TenantRequired` (never the
 * tenant `"default"`); an application without one runs as `"default"`.
 */
import { describe, expect } from "vitest";
import { ValidationError } from "../../src/core/error-families/effect-errors.js";
import { testWith } from "../../src/testing/index.js";
import { GetOrderTool } from "../flow/fixtures/eval-desk.fixture.js";
import { HistoryDeskApplication } from "../flow/fixtures/execution-history.fixture.js";

const strict = testWith(HistoryDeskApplication);
const suiteTenant = testWith(HistoryDeskApplication, { tenant: { tenantId: "acme", plan: "pro" } });

describe("#1328: a run on its own in an application with a tenantContext", () => {
  strict("with no tenant at all is ValidationError.TenantRequired", async ({ app }) => {
    await expect(app.runTool(GetOrderTool, { orderId: "1" })).rejects.toBeInstanceOf(
      ValidationError.TenantRequired,
    );
  });

  strict("the call's own tenant runs it and gives a UnitRun", async ({ app }) => {
    const run = await app.runTool(
      GetOrderTool,
      { orderId: "1" },
      { tenant: { tenantId: "acme", plan: "pro" } },
    );

    expect(run.output).toMatchObject({ kind: "ok" });
    expect(run.spend.totalUsd).toBe(0);
  });

  suiteTenant("the suite's tenant is the default of every call", async ({ app }) => {
    const run = await app.runTool(GetOrderTool, { orderId: "1" });

    expect(run.output).toMatchObject({ kind: "ok" });
  });
});
