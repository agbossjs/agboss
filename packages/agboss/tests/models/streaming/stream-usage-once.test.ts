import { afterEach, describe, expect, it } from "vitest";
import { CostLedgerRepository } from "../../../src/infrastructure/cost-ledger.repository.js";
import { ChatStart } from "../../channels/approval.workflow.js";
import { execute } from "../../helpers/flow.js";
import { ScriptedBedrockClient } from "../transport/bedrock-provider.fixture.js";
import { SeenLedger } from "../seen-ledger.js";
import { transportApp } from "../transport/transport-app.js";
import { Budget, BudgetScope, type BudgetHandler } from "../../../src/budgets/budget.js";
import { usd, type Usd } from "../../../src/units/index.js";
import { TestApplicationDailyBudget, TestTenantDailyBudget } from "../../flow/fixtures/budgets.js";
import { bedrockApplicationOn, workflowsOn } from "../transport/bedrock-apps.fixture.js";
import { StreamOpenRouterApplication, StreamOpenRouterProvider } from "./http-streaming.fixture.js";
import { sseServer, type SseServer } from "./sse-server.js";
import {
  UsageShape,
  WIRE_HOST,
  WIRE_USAGE,
  plainWithUsage,
  streamWithSplitUsage,
  streamWithUsage,
} from "./usage-shapes.js";

/**
 * #1231: a streamed answer records the wire's usage exactly once — its cost (`usage.cost`), its
 * tokens and its host — in the run's spend, the ledger and the budgets, whichever chunk carries the
 * usage. OpenRouter's last chunk has a choice and the usage together: merging the chunks added
 * the cost twice and wrote the host twice.
 */

const servers: SseServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** One run on a stream of `shape` (or a plain call): its spend and its ledger. */
async function runOn(
  shape: UsageShape | "plain" | "split",
  application = StreamOpenRouterApplication,
) {
  const script =
    shape === "split"
      ? streamWithSplitUsage(["Hello", " there"])
      : streamWithUsage(["Hello", " there"], shape === "plain" ? UsageShape.OwnChunk : shape);
  const server = await sseServer([script], plainWithUsage("Hello there"));
  servers.push(server);
  const ledger = new SeenLedger();
  const app = await transportApp(application, {
    client: new ScriptedBedrockClient([]),
    send: server.send,
    overrides: new Map([[CostLedgerRepository, ledger]]),
  });
  const done = await execute(
    app,
    ChatStart,
    { text: "hi" },
    shape === "plain" ? undefined : { onStream: () => undefined },
  );
  await app.close();
  return { done, ledger, stream: server.requests[0]?.body.stream };
}

/** What the wire said: one call, its exact cost, its tokens and its host. */
const WIRE_RECORD = {
  costUsd: WIRE_USAGE.cost,
  costSource: "api",
  inputTokens: WIRE_USAGE.prompt_tokens,
  outputTokens: WIRE_USAGE.completion_tokens,
  servedBy: WIRE_HOST,
};

describe("#1231: a streamed call records the wire's usage once", () => {
  it("the plain call (usage only in the one response) records the wire's usage", async () => {
    const { done, ledger, stream } = await runOn("plain");

    expect(stream).toBe(false);
    expect(done.spend.trace).toEqual([expect.objectContaining(WIRE_RECORD)]);
    expect(ledger.entries).toEqual([expect.objectContaining(WIRE_RECORD)]);
  });

  it.each(Object.values(UsageShape))(
    "%s: the spend, the ledger row and the budgets' charge are the wire's, once",
    async (shape) => {
      const streamed = await runOn(shape);
      const plain = await runOn("plain");

      expect(streamed.stream).toBe(true);
      expect(streamed.done.output).toEqual({ text: "Hello there" });
      expect(streamed.done.spend.trace).toEqual([expect.objectContaining(WIRE_RECORD)]);
      expect(streamed.done.spend.totalUsd).toBeCloseTo(WIRE_USAGE.cost ?? 0, 12);
      expect(streamed.ledger.entries).toEqual([expect.objectContaining(WIRE_RECORD)]);
      expect(streamed.ledger.charged).toEqual(plain.ledger.charged);
      expect(streamed.done.spend).toEqual(plain.done.spend);
    },
  );
});

describe("#1329: one event's JSON cut over two data lines is one event", () => {
  it("the cost is the wire's, once, and the host is kept — as a plain call records", async () => {
    const split = await runOn("split");
    const plain = await runOn("plain");

    expect(split.stream).toBe(true);
    expect(split.done.output).toEqual({ text: "Hello there" });
    expect(split.done.spend.trace).toEqual([expect.objectContaining(WIRE_RECORD)]);
    expect(split.done.spend.totalUsd).toBeCloseTo(WIRE_USAGE.cost ?? 0, 12);
    expect(split.ledger.entries).toEqual([expect.objectContaining(WIRE_RECORD)]);
    expect(split.ledger.charged).toEqual([WIRE_USAGE.cost]);
    expect(split.done.spend).toEqual(plain.done.spend);
  });
});

/** An execution may spend 1.5 calls' worth: one call fits, a call counted twice does not. */
@Budget({ name: "one-call-1231-execution-budget", scope: BudgetScope.Execution })
class OneCallExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd((WIRE_USAGE.cost ?? 0) * 1.5);
  }
}

const OneCallApplication = bedrockApplicationOn({
  name: "one-call-1231-application",
  desk: workflowsOn("or-stream/model", "one-call-1231"),
  providers: [StreamOpenRouterProvider],
  budgets: [TestApplicationDailyBudget, TestTenantDailyBudget, OneCallExecutionBudget],
});

describe("#1231: the budgets read the corrected number", () => {
  it("a streamed OpenRouter call spends one call of an execution budget of 1.5 calls", async () => {
    const { done, ledger } = await runOn(UsageShape.OnFinishChoice, OneCallApplication);

    expect(done.output).toEqual({ text: "Hello there" });
    expect(done.spend.totalUsd).toBeCloseTo(WIRE_USAGE.cost ?? 0, 12);
    expect(ledger.charged).toEqual([WIRE_USAGE.cost]);
  });
});
