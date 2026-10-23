/**
 * #385 — a transport provider (`ModelProviderHandler.complete(request)`): served by `serves`,
 * created lazily by the application's container (one instance, its `deps` injected — `TenantContext`
 * read in the execution's frame), its request in the framework's own types, its answer accounted
 * (the price table, or its own `cost`) and checked against the budgets before the call.
 */
import { describe, expect, it } from "vitest";
import { BudgetExceededError } from "../../../src/index.js";
import {
  Budget,
  BudgetPeriod,
  BudgetScope,
  type BudgetHandler,
} from "../../../src/budgets/budget.js";
import { ModelProviderMessageRole } from "../../../src/models/index.js";
import { usd, type Usd } from "../../../src/units/index.js";
import { ChatStart } from "../../channels/approval.workflow.js";
import { TestApplicationDailyBudget, TestExecutionBudget } from "../../flow/fixtures/budgets.js";
import { execute } from "../../helpers/flow.js";
import { BedrockApplication, VerdictStart, bedrockApplicationOn } from "./bedrock-apps.fixture.js";
import { answer, BedrockModelProvider, ScriptedBedrockClient } from "./bedrock-provider.fixture.js";
import { transportApp } from "./transport-app.js";

@Budget({ name: "tiny-tenant-daily-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
class TinyTenantDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

describe("#385: a transport provider serves its models through complete(request)", () => {
  it("complete() gets the model, the messages, the tools and a signal; its text is the finish", async () => {
    const client = new ScriptedBedrockClient([answer("Shipped.")]);
    const app = await transportApp(BedrockApplication, { client });

    const result = await execute(app, ChatStart, { text: "where is order 7?" });

    expect(result.output).toEqual({ text: "Shipped." });
    const [call] = client.invocations;
    expect(call?.model).toBe("bedrock/claude");
    expect(call?.tools).toEqual([]);
    expect(call?.signal).toBeInstanceOf(AbortSignal);
    expect(call?.messages.map((message) => message.role)).toEqual([
      ModelProviderMessageRole.System,
      ModelProviderMessageRole.User,
    ]);
    expect(call?.messages.at(-1)?.text).toContain("where is order 7?");
    await app.close();
  });

  it("deps: the container creates it on its first call, once, and its TenantContext is the execution's", async () => {
    const client = new ScriptedBedrockClient([answer("a")]);
    const created: unknown[] = [];
    const app = await transportApp(BedrockApplication, { client, created });
    const providers = (): number => created.filter((i) => i instanceof BedrockModelProvider).length;

    expect(providers()).toBe(0);
    await execute(app, ChatStart, { text: "one" }, { tenant: { tenantId: "acme" } });
    await execute(app, ChatStart, { text: "two" }, { tenant: { tenantId: "globex" } });

    expect(providers()).toBe(1);
    expect(client.invocations.map((call) => call.tenantId)).toEqual(["acme", "globex"]);
    await app.close();
  });

  it("a DTO agent: its answer tool is in request.tools and its tool call is the finish's DTO", async () => {
    const client = new ScriptedBedrockClient([
      ({ tools }) =>
        answer("", {
          toolCalls: [{ id: "c1", name: tools[0]?.name ?? "", arguments: { verdict: "guilty" } }],
        }),
    ]);
    const app = await transportApp(BedrockApplication, { client });

    const result = await execute(app, VerdictStart, { text: "the case" });

    expect(result.output).toEqual({ verdict: "guilty" });
    expect(client.invocations[0]?.tools[0]).toMatchObject({
      name: expect.stringMatching(/^answer-/),
      parameters: expect.objectContaining({ type: "object" }),
    });
    await app.close();
  });

  it("the price table prices it (price-table); its own cost wins (api)", async () => {
    const client = new ScriptedBedrockClient([answer("a"), answer("b", { cost: usd(0.25) })]);
    const app = await transportApp(BedrockApplication, { client });

    const priced = await execute(app, ChatStart, { text: "one" });
    const reported = await execute(app, ChatStart, { text: "two" });

    // 1M input × $3 + 0.5M output × $15 = $10.50
    expect(priced.spend.trace).toEqual([
      expect.objectContaining({
        model: "bedrock/claude",
        costUsd: 10.5,
        costSource: "price-table",
      }),
    ]);
    expect(reported.spend.trace).toEqual([
      expect.objectContaining({ costUsd: 0.25, costSource: "api" }),
    ]);
    await app.close();
  });

  it("budgets: its cost goes to the ledger, and an exhausted budget rejects before complete()", async () => {
    const client = new ScriptedBedrockClient([answer("a")]);
    const application = bedrockApplicationOn({
      name: "tiny-bedrock-application",
      budgets: [TestApplicationDailyBudget, TinyTenantDailyBudget, TestExecutionBudget],
    });
    const app = await transportApp(application, { client });

    await execute(app, ChatStart, { text: "one" }, { tenant: { tenantId: "acme" } });
    const second = execute(app, ChatStart, { text: "two" }, { tenant: { tenantId: "acme" } });

    await expect(second).rejects.toBeInstanceOf(BudgetExceededError);
    expect(client.invocations).toHaveLength(1);
    await app.close();
  });
});
