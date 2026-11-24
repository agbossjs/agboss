/**
 * #934: a paused run is read whole by the core (`pausedRunOfValue`). `sqlite/paused-run.json` is a run
 * in the shape 0.1.1 writes it: `turnId`, a pending approval with `step`, `answerer` and `kind`, every
 * usage naming its provider, a launch's group by `targets`. A wrong-typed field is refused by name.
 */
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { pausedRunOfValue, StoredNamesUnreadableError } from "../../src/stores/index.js";
import { pausedRun as RUN } from "./sqlite/stored-rows.fixtures.js";

const SECRET = "sk-live-PLANTED-SECRET-934";

describe("a paused run is read whole", () => {
  it("as 0.1.1 writes it: turnId, the pending approval, the launch's targets, the provider", () => {
    const run = pausedRunOfValue(RUN);

    expect(run).toMatchObject({ turnId: "turn-1", threadId: "t-1", budgetUsd: 5 });
    expect(run.pending[0]).toMatchObject({
      kind: "approval",
      step: "clerk-agent",
      answerer: "channel",
      toolCall: { tool: "refund" },
      input: {},
    });
    expect(run.data.launches?.[0]?.group).toEqual({ targets: ["a"], priority: 1 });
    expect(run.data.launches?.[0]?.branches[0]?.nodeId).toBe("b");
    expect(run.data.compensations?.[0]?.compensated.nodeId).toBe("clerk-agent");
    expect(run.cost.trace[0]?.provider).toBe("openrouter");
    expect(run.cost.unknownCalls).toBe(0);
  });

  it("a pending question and no cost limit", () => {
    const run = pausedRunOfValue({
      ...RUN,
      turnId: "turn-2",
      budgetUsd: Infinity,
      pending: [
        {
          pauseId: "p2",
          kind: "question",
          answerer: "thread-owner",
          step: "asker",
          channel: "c",
          input: { topic: "free" },
          trail: [{ action: "opened", at: "2026-01-05T09:00:00.000Z", target: "c" }],
        },
      ],
    });

    expect(run).toMatchObject({ turnId: "turn-2", budgetUsd: Infinity });
    expect(run.pending[0]).toMatchObject({ kind: "question", input: { topic: "free" } });
  });

  it.each([
    ["a cost that is a text", { cost: SECRET }, "cost"],
    ["a data whose scope is a text", { data: { scope: SECRET } }, "data.scope"],
    ["a pending list of numbers", { pending: [42] }, "pending.0"],
    [
      "a pending pause with no step",
      { pending: [{ pauseId: "p", channel: "c", answerer: "channel", input: {}, trail: [] }] },
      "pending.0",
    ],
    ["a budget that is a text", { budgetUsd: SECRET }, "budgetUsd"],
    ["a run with no turnId", { turnId: undefined }, "turnId"],
  ])("%s is unreadable: the ids and the field, no value", (_name, change, field) => {
    let error: unknown;
    try {
      pausedRunOfValue({ ...RUN, ...change });
    } catch (thrown) {
      error = thrown;
    }

    expect(error).toBeInstanceOf(StoredNamesUnreadableError);
    if (!(error instanceof Error)) throw new TypeError("nothing was thrown");
    expect(error.message).toContain("threadId t-1, runId run-1");
    expect(error.message).toContain(field);
    expect(inspect(error, { depth: 12 })).not.toContain(SECRET);
  });

  const pending = (change: Record<string, unknown>) => ({
    pending: [
      {
        pauseId: "p",
        kind: "approval",
        answerer: "channel",
        step: "clerk-agent",
        channel: "c",
        input: {},
        toolCall: { callId: "c1", tool: "refund", summary: "s" },
        trail: [],
        ...change,
      },
    ],
  });

  it.each([
    ["ternId, 0.1.0's name of turnId", { ternId: "turn-1" }, "ternId"],
    ["a pending pause with 0.1.0's agent", pending({ agent: "clerk-agent" }), "pending.0.agent"],
    [
      "a pending pause with 0.1.0's answeredBy beside its answerer, the same kind or another",
      pending({ answeredBy: "channel" }),
      "pending.0.answeredBy",
    ],
    [
      "a pending pause with 0.1.0's answeredBy of another kind",
      pending({ answeredBy: "thread-owner" }),
      "pending.0.answeredBy",
    ],
    ["a run with no tenantId", { tenantId: undefined }, "tenantId"],
    ["a pending pause with no kind", pending({ kind: undefined }), "pending.0.kind"],
  ])("0.1.0 is refused, never defaulted: %s", (_name, change, field) => {
    let error: unknown;
    try {
      pausedRunOfValue({ ...RUN, ...change });
    } catch (thrown) {
      error = thrown;
    }

    expect(error).toBeInstanceOf(StoredNamesUnreadableError);
    if (!(error instanceof Error)) throw new TypeError("nothing was thrown");
    expect(error.message).toContain(field);
    expect(inspect(error, { depth: 12 })).not.toContain(SECRET);
  });
});
