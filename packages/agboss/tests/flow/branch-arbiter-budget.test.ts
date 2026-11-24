/**
 * #1366: what the budgets are asked before a branch's model arbiter calls its model — the whole spend so far:
 * the execution's records, the services' and what the arbiter spent already, so a call that would pass the
 * budget is refused before it is paid.
 */
import { describe, expect, it } from "vitest";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../src/finops/usage.js";
import { arbiterDepsFor } from "../../src/flow/runtime/launch/branch-quorum.js";

const record = (costUsd: number, caller: string): UsageRecord => ({
  ...ZERO_USAGE,
  caller,
  model: "m",
  costUsd,
  costSource: CostSource.Api,
});

describe("#1366: the budgets before a branch arbiter's model call", () => {
  it("are refreshed, then checked with the view's, the services' and the arbiter's own records, at the node's path", async () => {
    const calls: unknown[] = [];
    const site = {
      limits: {
        budgets: {
          refresh: () => {
            calls.push("refresh");
            return Promise.resolve();
          },
          check: (spent: readonly UsageRecord[], path: readonly string[]) => {
            calls.push([spent.map((each) => each.caller), path]);
          },
        },
      },
      live: { controller: new AbortController() },
      view: { usage: [record(0.25, "view")], path: ["flow"] },
      services: [record(0.125, "service")],
      nodeId: "pick",
    };

    await arbiterDepsFor(site as never).beforeModelCall([record(0.5, "arbiter")]);

    expect(calls).toEqual([
      "refresh",
      [
        ["view", "service", "arbiter"],
        ["flow", "pick"],
      ],
    ]);
  });
});
