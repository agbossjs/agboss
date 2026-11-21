/**
 * #1366 (budget-loop shard) — the mesh services of one tool call, each rule on its own: the budget left it hands on
 * (none when the budgets keep no count or it is not a number), the end of its call — the tool's `timeout`, or
 * the execution's deadline when that is sooner — and the first remote execution a trusted peer reported.
 */
import { describe, expect, it } from "vitest";
import { toolMeshCallOf } from "../../src/graph/agent-loop/mesh-call.js";

const STARTED = new Date("2026-11-21T12:00:00.000Z");
const tool = { name: "call-tool", timeout: 60_000 };

describe("#1366: the budget a tool call hands on", () => {
  it("is what the budgets say is left", () => {
    const { services } = toolMeshCallOf(tool, { remaining: () => 2.5 } as never, STARTED);

    expect(services.remainingBudget()).toBe(2.5);
    expect(services.tool).toBe("call-tool");
  });

  it("is none when the budgets keep no count, or the count is no finite number", () => {
    const none = toolMeshCallOf(tool, {} as never, STARTED).services;
    const infinite = toolMeshCallOf(tool, { remaining: () => Infinity } as never, STARTED).services;
    const nan = toolMeshCallOf(tool, { remaining: () => NaN } as never, STARTED).services;

    expect(none.remainingBudget()).toBeUndefined();
    expect(infinite.remainingBudget()).toBeUndefined();
    expect(nan.remainingBudget()).toBeUndefined();
  });

  it("zero left is a budget left, not none", () => {
    expect(
      toolMeshCallOf(tool, { remaining: () => 0 } as never, STARTED).services.remainingBudget(),
    ).toBe(0);
  });
});

describe("#1366: the end of a tool call's remote calls", () => {
  it("is the tool's timeout after the start when the execution has no deadline", () => {
    const { services } = toolMeshCallOf(tool, {} as never, STARTED);

    expect(services.deadlineAt.toISOString()).toBe("2026-11-21T12:01:00.000Z");
  });

  it("is the execution's deadline when it is sooner than the timeout", () => {
    const budgets = { deadline: { at: "2026-11-21T12:00:10.000Z" } };

    const { services } = toolMeshCallOf(tool, budgets as never, STARTED);

    expect(services.deadlineAt.toISOString()).toBe("2026-11-21T12:00:10.000Z");
  });

  it("is the timeout when the deadline is later", () => {
    const budgets = { deadline: { at: "2026-11-21T13:00:00.000Z" } };

    const { services } = toolMeshCallOf(tool, budgets as never, STARTED);

    expect(services.deadlineAt.toISOString()).toBe("2026-11-21T12:01:00.000Z");
  });
});

describe("#1366: the remote execution a call reports", () => {
  it("is none until a peer reports one, and the first one stays", () => {
    const { services, remote } = toolMeshCallOf(tool, {} as never, STARTED);
    const first = { application: "a", executionId: "e1", mesh: true } as never;
    const second = { application: "b", executionId: "e2", mesh: true } as never;

    expect(remote()).toBeUndefined();
    services.recordRemote(first);
    services.recordRemote(second);

    expect(remote()).toBe(first);
  });
});
