import { describe, expect, it, vi } from "vitest";
import { accountedRouters } from "../../src/components/accounted-router.js";
import { inToolCallFrame, runInFrame } from "../../src/flow/context/frame.js";
import type { UsageRecord } from "../../src/finops/usage.js";
import type { RouteOutcome } from "../../src/routers/index.js";
import { testExecutionContext } from "../../src/testing/index.js";
import { usageRecord } from "../helpers.js";

const decided = (usage?: UsageRecord): RouteOutcome => ({
  kind: "decided",
  decision: { next: "a", reason: "test" },
  ...(usage === undefined ? {} : { usage }),
});

const routersAnswering = (outcome: RouteOutcome) =>
  accountedRouters((name) => ({ name, route: () => Promise.resolve(outcome) }));

const request = { input: "x", options: [] };

function agentFrame() {
  const agent = testExecutionContext({ executionId: "exec-1" });
  const { executionId, threadId, ownerId, signal, workflow, tenant } = agent;
  return {
    execution: { executionId, threadId, ownerId, signal, workflow, tenant, values: {} },
    step: agent.step,
  };
}

describe("#280: ROUTER_FACTORY spend inside a tool call is the tool's", () => {
  it("a decision during a tool call reports its usage to that call", async () => {
    const reportUsage = vi.fn();
    const spent = usageRecord("router:ranker", 0.01);
    const router = routersAnswering(decided(spent))("ranker");

    await runInFrame(agentFrame(), () =>
      inToolCallFrame("call_1", { reportUsage }, () => router.route(request)),
    );

    expect(router.name).toBe("ranker");
    expect(reportUsage).toHaveBeenCalledWith(spent);
  });

  it("outside a tool call, and without a model call, nothing is reported", async () => {
    const reportUsage = vi.fn();
    const paid = routersAnswering(decided(usageRecord("router:ranker", 0.01)))("ranker");
    const free = routersAnswering(decided())("ranker");

    const outcome = await paid.route(request);
    await runInFrame(agentFrame(), () =>
      inToolCallFrame("call_1", { reportUsage }, () => free.route(request)),
    );

    expect(outcome.kind).toBe("decided");
    expect(reportUsage).not.toHaveBeenCalled();
  });
});
