/**
 * #384 — `testToolInterceptor`: an interceptor on its own container, its rules checked first, each
 * call in the frame of a call to the tool (the tenant given), `beforeToolCall` giving the decision,
 * `afterToolCall` the output validated against the tool's output DTO.
 */
import { describe, expect, it } from "vitest";
import {
  DtoValidationError,
  GraphRuleError,
  ToolCallDecision,
  ToolInterceptor,
} from "../../src/index.js";
import { TestSetupError, testToolInterceptor } from "../../src/testing/index.js";
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

describe("#384: testToolInterceptor", () => {
  const scope = testToolInterceptor(TenantScopeToolInterceptor, {
    tenantContext: JobScoutTenantContext,
    tenant: { tenantId: "acme", allowedCities: ["Haifa"] },
  });

  it("beforeToolCall gives the decision, read for the tenant given", async () => {
    const eilat = await scope.beforeToolCall(JobSearchTool, { city: "Eilat" });
    const haifa = await scope.beforeToolCall(JobSearchTool, { city: "Haifa" });

    expect(eilat.output).toEqual(
      ToolCallDecision.replyToModel({ message: 'City "Eilat" is not allowed for this tenant.' }),
    );
    expect(eilat.output).not.toEqual(ToolCallDecision.allow());
    expect(haifa.output).toEqual(ToolCallDecision.allow());
    expect(haifa.spend.totalUsd).toBe(0);
  });

  it("afterToolCall gives the output the model would read, validated", async () => {
    const stamp = testToolInterceptor(StampToolInterceptor);

    const { output } = await stamp.afterToolCall(
      JobSearchTool,
      { city: "Haifa" },
      { listing: "Engineer" },
    );

    expect(output).toEqual({ listing: "Engineer (checked)" });
    const moody = testToolInterceptor(MoodyToolInterceptor);
    await expect(
      moody.afterToolCall(PingTool, { mode: "shape" }, { text: "pong" }),
    ).rejects.toBeInstanceOf(DtoValidationError);
  });

  it("runs in the frame of a call to the tool", async () => {
    interceptorLog.length = 0;
    const audit = testToolInterceptor(AuditToolInterceptor);

    await audit.beforeToolCall(JobSearchTool, { city: "Haifa" });

    expect(interceptorLog[0]?.idempotencyKey).toMatch(/:test-call$/);
    expect(interceptorLog[0]?.tool).toBe("job-search-tool");
  });

  it("a misbehaving interceptor rejects as it does", async () => {
    const moody = testToolInterceptor(MoodyToolInterceptor);

    await expect(moody.beforeToolCall(PingTool, { mode: "throw" })).rejects.toThrow(
      "the scope service is down",
    );
    await expect(moody.beforeToolCall(PingTool, { mode: "nothing" })).rejects.toThrow(
      /returned no ToolCallDecision/,
    );
  });

  it("a method the class does not have, a class that breaks a rule: set-up errors", () => {
    expect(() =>
      testToolInterceptor(StampToolInterceptor).beforeToolCall(JobSearchTool, { city: "Haifa" }),
    ).toThrow(TestSetupError);

    @ToolInterceptor({ name: "short", description: "Lacks its suffix" })
    class Short {
      beforeToolCall(): ToolCallDecision {
        return ToolCallDecision.allow();
      }
    }
    expect(() => testToolInterceptor(Short)).toThrow(GraphRuleError);
    expect(() => testToolInterceptor(JobSearchTool as never)).toThrow(TestSetupError);
  });
});
