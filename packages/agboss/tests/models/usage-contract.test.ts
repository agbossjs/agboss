import { afterEach, describe, expect, it } from "vitest";
import type { Class } from "../../src/components/injection.js";
import { CostLedgerRepository } from "../../src/infrastructure/cost-ledger.repository.js";
import type { ModelProviderResponse } from "../../src/models/index.js";
import { usd } from "../../src/units/index.js";
import { ChatStart } from "../channels/approval.workflow.js";
import { execute } from "../helpers/flow.js";
import {
  StreamApplication,
  StreamOpenRouterApplication,
} from "./streaming/http-streaming.fixture.js";
import { sseServer, type SseServer } from "./streaming/sse-server.js";
import {
  ScriptedStreamClient,
  StreamSdkClient,
  TransportStreamApplication,
  streamOf,
} from "./streaming/transport-streaming.fixture.js";
import {
  UsageShape,
  WIRE_HOST,
  WIRE_USAGE,
  plainWithUsage,
  streamWithUsage,
} from "./streaming/usage-shapes.js";
import { SeenLedger } from "./seen-ledger.js";
import { BedrockApplication } from "./transport/bedrock-apps.fixture.js";
import { ScriptedBedrockClient } from "./transport/bedrock-provider.fixture.js";
import { transportApp } from "./transport/transport-app.js";

/**
 * #1231, the invariant of every provider path: what AGBoss records of one call — its cost, its
 * tokens, its host — is what the provider reported for it, once. The run's spend, the ledger's
 * entry and the budgets' charge all read that one record.
 */

const servers: SseServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** What the provider reported for the call: what must be recorded. */
interface Wire {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly costSource: "api" | "price-table";
  readonly servedBy?: string;
}

/** One path: how its one call is made, on which application, with what on the wire. */
interface ProviderPath {
  readonly name: string;
  readonly application: Class;
  readonly wire: Wire;
  readonly streamed: boolean;
  readonly parts: () => Promise<Partial<Parameters<typeof transportApp>[1]>>;
}

const { prompt_tokens: inputTokens = 0, completion_tokens: outputTokens = 0 } = WIRE_USAGE;
const WITHOUT_COST = { prompt_tokens: inputTokens, completion_tokens: outputTokens };

/** An HTTP provider over a 127.0.0.1 server: its stream in `shape`, its plain answer. */
const http =
  (shape: UsageShape, usage = WIRE_USAGE) =>
  async () => {
    const server = await sseServer(
      [streamWithUsage(["Hello", " there"], shape, usage)],
      plainWithUsage("Hello there", usage),
    );
    servers.push(server);
    return { send: server.send };
  };

/** A transport whose `complete()` answers `response` (the CLI providers' path too). */
const completing = (response: ModelProviderResponse) => () =>
  Promise.resolve({ client: new ScriptedBedrockClient([response]) });

const API = {
  inputTokens,
  outputTokens,
  costUsd: WIRE_USAGE.cost ?? 0,
  costSource: "api",
} as const;
const MILLION = { inputTokens: 1_000_000, outputTokens: 500_000 };

const PATHS: readonly ProviderPath[] = [
  {
    name: "HTTP complete() — OpenRouter's usage.cost and host",
    application: StreamOpenRouterApplication,
    wire: { ...API, servedBy: WIRE_HOST },
    streamed: false,
    parts: http(UsageShape.OwnChunk),
  },
  ...Object.values(UsageShape).map((shape) => ({
    name: `HTTP stream() — OpenRouter, ${shape}`,
    application: StreamOpenRouterApplication,
    wire: { ...API, servedBy: WIRE_HOST },
    streamed: true,
    parts: http(shape),
  })),
  ...[UsageShape.OnFinishChoice, UsageShape.Repeated].map((shape) => ({
    name: `HTTP stream() — no usage.cost, tokens × prices, ${shape}`,
    application: StreamApplication,
    // 0.12M × $1 + 0.03M × $2 per million
    wire: { inputTokens, outputTokens, costUsd: 0.18, costSource: "price-table" as const },
    streamed: true,
    parts: http(shape, WITHOUT_COST),
  })),
  {
    name: "transport complete() — the provider's exact cost",
    application: BedrockApplication,
    wire: { ...MILLION, costUsd: 0.25, costSource: "api" },
    streamed: true,
    parts: completing({ text: "a", usage: MILLION, cost: usd(0.25) }),
  },
  {
    name: "transport complete() — usage only, tokens × prices (the CLI providers' answer)",
    application: BedrockApplication,
    wire: { ...MILLION, costUsd: 10.5, costSource: "price-table" }, // 1M × $3 + 0.5M × $15
    streamed: false,
    parts: completing({ text: "a", usage: MILLION }),
  },
  {
    name: "transport stream() — its usage promise, tokens × prices",
    application: TransportStreamApplication,
    wire: { ...MILLION, costUsd: 2, costSource: "price-table" }, // 1M × $1 + 0.5M × $2
    streamed: true,
    parts: () =>
      Promise.resolve({
        client: new ScriptedBedrockClient([]),
        overrides: new Map([[StreamSdkClient, new ScriptedStreamClient([streamOf(["a", "b"])])]]),
      }),
  },
];

/** The path's one call: the run's spend and the ledger's view of it. */
async function callOn(path: ProviderPath) {
  const ledger = new SeenLedger();
  const { overrides, client, ...parts } = await path.parts();
  const app = await transportApp(path.application, {
    client: client ?? new ScriptedBedrockClient([]),
    ...parts,
    overrides: new Map([...(overrides ?? []), [CostLedgerRepository, ledger]]),
  });
  const done = await execute(
    app,
    ChatStart,
    { text: "hi" },
    path.streamed ? { onStream: () => undefined } : undefined,
  );
  await app.close();
  return { done, ledger };
}

describe("#1231: every provider path records the wire's usage, once", () => {
  it.each(PATHS)("$name", async (path) => {
    const { done, ledger } = await callOn(path);
    expect(done.spend.trace).toHaveLength(1);
    expect(done.spend.trace[0]).toMatchObject(path.wire);
    expect(done.spend.trace[0]?.servedBy).toBe(path.wire.servedBy);
    expect(done.spend.totalUsd).toBeCloseTo(path.wire.costUsd, 12);
    expect(ledger.entries).toEqual([expect.objectContaining(path.wire)]);
    expect(ledger.charged).toHaveLength(1);
    expect(ledger.charged[0]).toBeCloseTo(path.wire.costUsd, 12);
  });
});
