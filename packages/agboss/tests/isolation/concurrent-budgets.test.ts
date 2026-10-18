/** #202 AC2: concurrent runs reserve their budget, so together they never pass the daily cap. */
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/application/create-app.js";
import { PerRunLimitRequiredError } from "../../src/index.js";
import { createMemoryLedger } from "../../src/finops/ledger.js";
import { reserveSpend } from "../../src/finops/reservations.js";
import { applicationOf } from "../../src/application/assemble.js";
import { buildApplication } from "../../src/application/create-app.js";
import { replyWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { usd } from "../../src/units/index.js";
import { ChatStart } from "../channels/approval.workflow.js";
import { DraftDto, CappedApplication, DayCapOnlyApplication } from "./isolation.workflow.js";
import { execute } from "../helpers/flow.js";

const step = replyWith("done", { cost: usd(0.2) });
const draft = replyWith(DraftDto, { text: "draft" }, { cost: usd(0.2) });

describe("#202 AC2: budget is reserved before the first model call", () => {
  it("AC2: five concurrent runs of $0.40 each under a $1.00 day spend $1.00, not $2.00", async () => {
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

    const answered = runs.filter((run) => run.status === "fulfilled");
    const failed = runs
      .filter((run): run is PromiseRejectedResult => run.status === "rejected")
      .map((run): unknown => run.reason);
    expect(answered).toHaveLength(2);
    expect(failed).toHaveLength(3);
    for (const reason of failed) {
      expect(reason).toMatchObject({ code: "limit.budget", key: "limits.perDay.cost" });
    }
    expect(await infrastructure.costLedger.findSpentToday("capped-workflow")).toBeCloseTo(1, 9);
    // two full runs and one that got only the $0.20 left: five model calls, not ten
    const calls = book.scriptOf("agent:drafter-agent").requests.length;
    expect(calls + book.scriptOf("agent:editor-agent").requests.length).toBe(5);
    await app.close();
  });

  it("AC2: a hold shrinks as its run spends and is freed when the run ends", async () => {
    const ledger = createMemoryLedger();
    const account = { key: "day", dailyCap: 1 };
    const first = await reserveSpend(ledger, account, 0.6);
    const second = await reserveSpend(ledger, account, 0.6);
    expect([first.grantedUsd, second.grantedUsd]).toEqual([0.6, expect.closeTo(0.4, 9)]);
    expect((await reserveSpend(ledger, account, 0.1)).grantedUsd).toBe(0);

    await first.record([
      {
        caller: "a",
        model: "m",
        costUsd: 0.1,
        costSource: "api",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    ]);
    first.release();
    first.release();
    expect((await reserveSpend(ledger, account, 1)).grantedUsd).toBeCloseTo(0.5, 9);
    expect((await reserveSpend(ledger, { key: "free", dailyCap: Infinity }, 3)).grantedUsd).toBe(3);
  });

  it("AC2: a daily cap without a run cap fails at start with [limits.per-run-required]", async () => {
    const book = new ScriptBook();
    const drafter = book.scriptOf("agent:drafter-agent").thenReturnAlways(draft);
    const start = createApp(DayCapOnlyApplication, {
      processEnv: {},
      gateway: createScriptedGateway(book),
    });

    await expect(start).rejects.toBeInstanceOf(PerRunLimitRequiredError);
    await expect(start).rejects.toMatchObject({ code: "limits.per-run-required" });
    await expect(start).rejects.toThrow(
      /\[limits\.per-run-required\] workflow "day-cap-only-workflow" .*add perRun: \{ cost \}/,
    );
    expect(drafter.requests).toEqual([]);
  });
});
