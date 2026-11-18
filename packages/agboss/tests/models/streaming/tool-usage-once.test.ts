import { afterEach, describe, expect, it } from "vitest";
import { Budget, BudgetScope, type BudgetHandler } from "../../../src/budgets/budget.js";
import { CostLedgerRepository } from "../../../src/infrastructure/cost-ledger.repository.js";
import { usd, type Usd } from "../../../src/units/index.js";
import { TestApplicationDailyBudget, TestTenantDailyBudget } from "../../flow/fixtures/budgets.js";
import { execute } from "../../helpers/flow.js";
import { SeenLedger } from "../seen-ledger.js";
import {
  LookupStart,
  bedrockApplicationOn,
  lookupToolOf,
  workflowsOn,
} from "../transport/bedrock-apps.fixture.js";
import { ScriptedBedrockClient } from "../transport/bedrock-provider.fixture.js";
import { transportApp } from "../transport/transport-app.js";
import { StreamOpenRouterApplication, StreamOpenRouterProvider } from "./http-streaming.fixture.js";
import { sseServer, type SseScript, type SseServer } from "./sse-server.js";
import {
  UsageShape,
  WIRE_HOST,
  WIRE_USAGE,
  plainWithUsage,
  streamWithUsage,
  streamedToolCall,
  type WireUsage,
} from "./usage-shapes.js";

/**
 * #1231 (acceptance H): an agent WITH a tool — its model bound to its tools (`bindTools`, which in
 * `@langchain/openai` makes a new plain client) — streamed on OpenRouter records each call at the
 * wire's cost once and its host once: in the run's spend, the ledger and the budgets, on every turn
 * of a tool loop.
 */

const servers: SseServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** The tool on the OpenRouter desk (`stream-or-1231`). */
const LOOKUP = lookupToolOf("stream-or-1231");

/** A second call's usage, other numbers than the first's: each turn is told apart. */
const SECOND_USAGE: WireUsage = {
  prompt_tokens: 130_000,
  completion_tokens: 20_000,
  total_tokens: 150_000,
  cost: 0.0377,
};

/** What the wire said of one call: its exact cost, its tokens and its host. */
const recordOf = (usage: WireUsage) => ({
  costUsd: usage.cost,
  costSource: "api",
  inputTokens: usage.prompt_tokens,
  outputTokens: usage.completion_tokens,
  servedBy: WIRE_HOST,
});

/** One run of the lookup workflow over `scripts` (one per model call), streamed or plain. */
async function runOn(
  scripts: readonly SseScript[],
  streamed: boolean,
  application = StreamOpenRouterApplication,
) {
  const server = await sseServer(scripts, plainWithUsage("Hello there"));
  servers.push(server);
  const ledger = new SeenLedger();
  const app = await transportApp(application, {
    client: new ScriptedBedrockClient([]),
    send: server.send,
    overrides: new Map([[CostLedgerRepository, ledger]]),
  });
  const done = await execute(
    app,
    LookupStart,
    { text: "hi" },
    streamed ? { onStream: () => undefined } : undefined,
  );
  await app.close();
  return { done, ledger, server };
}

describe("#1231: a tool-bound agent's streamed call records the wire's usage once", () => {
  it("the plain call (no onStream) records the wire's usage", async () => {
    const { done, ledger, server } = await runOn(
      [streamWithUsage(["Hello"], UsageShape.OwnChunk)],
      false,
    );

    expect(server.requests[0]?.body.stream).toBe(false);
    expect(server.requests[0]?.body.tools).toEqual([
      expect.objectContaining({ function: expect.objectContaining({ name: LOOKUP }) }),
    ]);
    expect(done.spend.trace).toEqual([expect.objectContaining(recordOf(WIRE_USAGE))]);
    expect(ledger.entries).toEqual([expect.objectContaining(recordOf(WIRE_USAGE))]);
  });

  it.each(Object.values(UsageShape))(
    "%s: one answer, streamed — the spend, the ledger row and the charge are the wire's, once",
    async (shape) => {
      const { done, ledger, server } = await runOn(
        [streamWithUsage(["Hello", " there"], shape)],
        true,
      );

      expect(server.requests[0]?.body.stream).toBe(true);
      expect(server.requests[0]?.body.tools).toHaveLength(1);
      expect(done.output).toEqual({ text: "Hello there" });
      expect(done.spend.trace).toEqual([expect.objectContaining(recordOf(WIRE_USAGE))]);
      expect(done.spend.totalUsd).toBeCloseTo(WIRE_USAGE.cost ?? 0, 12);
      expect(ledger.entries).toEqual([expect.objectContaining(recordOf(WIRE_USAGE))]);
      expect(ledger.charged).toEqual([WIRE_USAGE.cost]);
    },
  );

  it.each(Object.values(UsageShape))(
    "%s: a tool loop of two streamed calls — each recorded at its wire cost, once",
    async (shape) => {
      const { done, ledger, server } = await runOn(
        [
          streamedToolCall(LOOKUP, { query: "paris" }, shape),
          streamWithUsage(["Sunny", " in Paris"], shape, SECOND_USAGE),
        ],
        true,
      );

      expect(server.requests).toHaveLength(2);
      expect(JSON.stringify(server.requests[1]?.body.messages)).toContain("found paris");
      expect(done.output).toEqual({ text: "Sunny in Paris" });
      expect(done.spend.trace).toEqual([
        expect.objectContaining(recordOf(WIRE_USAGE)),
        expect.objectContaining(recordOf(SECOND_USAGE)),
      ]);
      expect(done.spend.totalUsd).toBeCloseTo(
        (WIRE_USAGE.cost ?? 0) + (SECOND_USAGE.cost ?? 0),
        12,
      );
      expect(ledger.entries).toEqual([
        expect.objectContaining(recordOf(WIRE_USAGE)),
        expect.objectContaining(recordOf(SECOND_USAGE)),
      ]);
      expect(ledger.charged).toEqual([WIRE_USAGE.cost, SECOND_USAGE.cost]);
    },
  );

  it("a tool loop of three streamed calls (OpenRouter's shape): three records, each once", async () => {
    const { done, ledger } = await runOn(
      [
        streamedToolCall(LOOKUP, { query: "paris" }, UsageShape.OnFinishChoice),
        streamedToolCall(LOOKUP, { query: "rome" }, UsageShape.OnFinishChoice, SECOND_USAGE),
        streamWithUsage(["Both sunny"], UsageShape.OnFinishChoice),
      ],
      true,
    );

    expect(done.output).toEqual({ text: "Both sunny" });
    expect(done.spend.trace.map((record) => record.costUsd)).toEqual([
      WIRE_USAGE.cost,
      SECOND_USAGE.cost,
      WIRE_USAGE.cost,
    ]);
    expect(done.spend.trace.map((record) => record.servedBy)).toEqual([
      WIRE_HOST,
      WIRE_HOST,
      WIRE_HOST,
    ]);
    expect(ledger.charged).toEqual([WIRE_USAGE.cost, SECOND_USAGE.cost, WIRE_USAGE.cost]);
  });
});

/** An execution may spend 1.5 calls' worth: one call fits, a call counted twice does not. */
@Budget({ name: "one-tool-call-1231-execution-budget", scope: BudgetScope.Execution })
class OneCallExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd((WIRE_USAGE.cost ?? 0) * 1.5);
  }
}

const OneCallApplication = bedrockApplicationOn({
  name: "one-tool-call-1231-application",
  desk: workflowsOn("or-stream/model", "stream-or-1231"),
  providers: [StreamOpenRouterProvider],
  budgets: [TestApplicationDailyBudget, TestTenantDailyBudget, OneCallExecutionBudget],
});

describe("#1231: the budgets read the corrected number for a tool-bound agent", () => {
  it("a streamed OpenRouter call of an agent with a tool spends one call of a 1.5-call budget", async () => {
    const { done, ledger } = await runOn(
      [streamWithUsage(["Hello", " there"], UsageShape.OnFinishChoice)],
      true,
      OneCallApplication,
    );

    expect(done.output).toEqual({ text: "Hello there" });
    expect(done.spend.totalUsd).toBeCloseTo(WIRE_USAGE.cost ?? 0, 12);
    expect(ledger.charged).toEqual([WIRE_USAGE.cost]);
  });
});
