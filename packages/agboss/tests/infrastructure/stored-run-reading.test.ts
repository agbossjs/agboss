/**
 * #934: a paused run is read whole by the core (`pausedRunOfValue`), version tolerant.
 * `paused-run-0.1.0.json` is a run in the shape of 0.1.0's `AgentExecutionOutput` — `ternId`, a
 * pending pause with `agent` and `answeredBy` and no `kind` — written as a typed literal against the
 * published `@agboss/core@0.1.0` declarations and printed with that package. A run at current main
 * (`turnId`, `step`, `answerer`, `kind`) reads too; a wrong-typed field does not.
 */
import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { pausedRunOfValue, StoredNamesUnreadableError } from "../../src/stores/index.js";

const OLD: Record<string, unknown> = JSON.parse(
  readFileSync(new URL("./sqlite/paused-run-0.1.0.json", import.meta.url), "utf8"),
);
const SECRET = "sk-live-PLANTED-SECRET-934";

describe("a paused run is read whole", () => {
  it("in the shape 0.1.0 wrote it: ternId is turnId, the pending pause has the new names", () => {
    const run = pausedRunOfValue(OLD);

    expect(run).toMatchObject({ turnId: "turn-1", threadId: "t-1", budgetUsd: 5 });
    expect(run).not.toHaveProperty("ternId");
    expect(run.pending[0]).toMatchObject({
      kind: "approval",
      step: "clerk-agent",
      answerer: "channel",
      answeredBy: "channel",
      ask: { tool: "refund" },
    });
    expect(run.data.launches?.[0]?.branches[0]?.nodeId).toBe("b");
    expect(run.data.compensations?.[0]?.compensated.nodeId).toBe("clerk-agent");
    expect(run.cost.unknownCalls).toBe(0);
  });

  it("at current main: turnId, step, answerer and a question; no cost limit", () => {
    const { ternId: _old, ...rest } = OLD;
    const run = pausedRunOfValue({
      ...rest,
      turnId: "turn-2",
      budgetUsd: Infinity,
      pending: [
        {
          pauseId: "p2",
          kind: "question",
          answerer: "thread-owner",
          answeredBy: "thread-owner",
          step: "asker",
          channel: "c",
          ask: { topic: "free" },
        },
      ],
    });

    expect(run).toMatchObject({ turnId: "turn-2", budgetUsd: Infinity });
    expect(run.pending[0]).toMatchObject({ kind: "question", ask: { topic: "free" } });
  });

  it.each([
    ["a cost that is a text", { cost: SECRET }, "cost"],
    ["a data whose scope is a text", { data: { scope: SECRET } }, "data.scope"],
    ["a pending list of numbers", { pending: [42] }, "pending.0"],
    [
      "a pending pause with no step",
      { pending: [{ pauseId: "p", channel: "c", answeredBy: "channel", ask: {} }] },
      "pending.0",
    ],
    ["a budget that is a text", { budgetUsd: SECRET }, "budgetUsd"],
    ["a run with neither turnId nor ternId", { ternId: undefined }, "turnId"],
  ])("%s is unreadable: the ids and the field, no value", (_name, change, field) => {
    let error: unknown;
    try {
      pausedRunOfValue({ ...OLD, ...change });
    } catch (thrown) {
      error = thrown;
    }

    expect(error).toBeInstanceOf(StoredNamesUnreadableError);
    if (!(error instanceof Error)) throw new TypeError("nothing was thrown");
    expect(error.message).toContain("threadId t-1, runId run-1");
    expect(error.message).toContain(field);
    expect(inspect(error, { depth: 12 })).not.toContain(SECRET);
  });
});
