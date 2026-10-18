/**
 * #261 PR 5 (replaces #202's reservations): nothing is reserved — a budget protects from draining
 * money, it is not exact accounting. Executions of one tenant that start together all pass the
 * check (nothing is spent yet) and may overrun the day; every call is counted, so the next
 * execution is rejected before its first call.
 */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { buildApplication } from "../../src/application/create-app.js";
import { BudgetExceededError, BudgetScope } from "../../src/index.js";
import { replyWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { usd } from "../../src/units/index.js";
import { ChatStart } from "../channels/approval.workflow.js";
import { DraftDto, CappedApplication } from "./isolation.workflow.js";
import { execute } from "../helpers/flow.js";

const step = replyWith("done", { cost: usd(0.2) });
const draft = replyWith(DraftDto, { text: "draft" }, { cost: usd(0.2) });

describe("#261: concurrent executions of one tenant share its counters, nothing reserved", () => {
  it("five concurrent $0.40 executions under a $1.00 day: counted, the next one rejected", async () => {
    const book = new ScriptBook();
    book.scriptOf("agent:drafter-agent").thenReturnAlways(draft);
    book.scriptOf("agent:editor-agent").thenReturnAlways(step);
    const { app, infrastructure } = await buildApplication(await applicationOf(CappedApplication), {
      processEnv: {},
      gateway: createScriptedGateway(book),
    });

    const runs = await Promise.allSettled(
      Array.from({ length: 5 }, (_, n) => execute(app, ChatStart, { text: `task ${String(n)}` })),
    );
    const failed = runs
      .filter((run): run is PromiseRejectedResult => run.status === "rejected")
      .map((run): unknown => run.reason);
    const today = new Date().toISOString().slice(0, 10);
    const spent = await infrastructure.costLedger.findSpentByCounter({
      budget: "capped-tenant-daily-budget",
      scope: BudgetScope.Tenant,
      key: "default",
      period: today,
    });

    for (const reason of failed) {
      expect(reason).toBeInstanceOf(BudgetExceededError);
      expect(reason).toMatchObject({ budget: { name: "capped-tenant-daily-budget" } });
    }
    // every call made is counted; the overrun is at most the executions already under way
    const calls = book.scriptOf("agent:drafter-agent").requests.length;
    const all = calls + book.scriptOf("agent:editor-agent").requests.length;
    expect(spent).toBeCloseTo(all * 0.2, 9);
    expect(spent).toBeGreaterThanOrEqual(1);
    expect(spent).toBeLessThanOrEqual(5 * 0.4 + 1e-9);
    // the day is spent: the next execution is rejected before its first call
    await expect(execute(app, ChatStart, { text: "one more" })).rejects.toThrow(
      /^tenant default spent \$[\d.]+ today; capped-tenant-daily-budget allows \$1$/,
    );
    expect(book.scriptOf("agent:drafter-agent").requests).toHaveLength(calls);
    await app.close();
  });
});
