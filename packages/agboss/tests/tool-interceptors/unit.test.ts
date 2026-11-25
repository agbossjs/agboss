/**
 * #384 — `testUnit`: an interceptor on its own container, its rules checked first, each
 * call in the frame of a call to the tool (the tenant given), `beforeToolCall` giving the decision,
 * `afterToolCall` the output validated against the tool's output DTO.
 */
import { ConfigError } from "../../src/core/error-families/config-errors.js";
import { describe, expect, it } from "vitest";
import { ToolCallDecision, ToolInterceptor, ValidationError } from "../../src/index.js";
import { TestSetupError, testUnit } from "../../src/testing/index.js";
import {
  AuditToolInterceptor,
  JobScoutTenantContext,
  JobSearchTool,
  MoodyToolInterceptor,
  PingTool,
  StampToolInterceptor,
  TenantScopeToolInterceptor,
  interceptorLog,
} from "./components.fixture.js";

describe("#384: testUnit", () => {
  const scope = testUnit(TenantScopeToolInterceptor, {
    tenantContext: JobScoutTenantContext,
    tenant: { tenantId: "acme", allowedCities: ["Haifa"] },
  });

  it("beforeToolCall gives the decision, read for the tenant given", async () => {
    const eilat = await scope.beforeToolCall(JobSearchTool, { city: "Eilat" });
    const haifa = await scope.beforeToolCall(JobSearchTool, { city: "Haifa" });

    expect(eilat.output).toEqual(
      ToolCallDecision.reply('City "Eilat" is not allowed for this tenant.'),
    );
    expect(eilat.output).not.toEqual(ToolCallDecision.allow());
    expect(haifa.output).toEqual(ToolCallDecision.allow());
    expect(haifa.spend.totalUsd).toBe(0);
  });

  it("a tool the class has no @BeforeTool method for passes through", async () => {
    const ping = await scope.beforeToolCall(PingTool, { mode: "ok" });

    expect(ping.output).toEqual(ToolCallDecision.allow());
  });

  it("afterToolCall gives the output the model would read, validated", async () => {
    const stamp = testUnit(StampToolInterceptor);

    const { output } = await stamp.afterToolCall(
      JobSearchTool,
      { city: "Haifa" },
      { listing: "Engineer" },
    );

    expect(output).toEqual({ listing: "Engineer (checked)" });
    const moody = testUnit(MoodyToolInterceptor);
    await expect(
      moody.afterToolCall(PingTool, { mode: "shape" }, { text: "pong" }),
    ).rejects.toBeInstanceOf(ValidationError.DtoInvalid);
  });

  it("runs in the frame of a call to the tool", async () => {
    interceptorLog.length = 0;
    const audit = testUnit(AuditToolInterceptor);

    await audit.beforeToolCall(JobSearchTool, { city: "Haifa" });

    expect(interceptorLog[0]?.idempotencyKey).toMatch(/:test-call$/);
    expect(interceptorLog[0]?.tool).toBe("job-search-tool");
  });

  it("a misbehaving interceptor rejects as it does", async () => {
    const moody = testUnit(MoodyToolInterceptor);

    await expect(moody.beforeToolCall(PingTool, { mode: "throw" })).rejects.toThrow(
      "the scope service is down",
    );
    await expect(moody.beforeToolCall(PingTool, { mode: "nothing" })).rejects.toThrow(
      /returned no ToolCallDecision/,
    );
  });

  it("a method the class does not have, a class that breaks a rule: set-up errors", () => {
    expect(() =>
      testUnit(StampToolInterceptor).beforeToolCall(JobSearchTool, { city: "Haifa" }),
    ).toThrow(TestSetupError);

    @ToolInterceptor({ name: "Short_One", description: "Not kebab-case" })
    class Short {
      beforeAnyTool(): ToolCallDecision {
        return ToolCallDecision.allow();
      }
    }
    expect(() => testUnit(Short)).toThrow(ConfigError.GraphRules);
    class Plain {
      readonly isPlain = true;
    }
    expect(() => testUnit(Plain as never)).toThrow(TestSetupError);
  });
});
