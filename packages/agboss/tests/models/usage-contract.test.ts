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
  type StreamInvocation,
} from "./streaming/transport-streaming.fixture.js";
import {
  UsageShape,
  WIRE_HOST,
  WIRE_USAGE,
  plainToolCallWithUsage,
  plainWithUsage,
  streamWithUsage,
  streamedToolCall,
  type WireUsage,
} from "./streaming/usage-shapes.js";
import { SeenLedger } from "./seen-ledger.js";
import { BedrockApplication, LookupStart, VerdictStart } from "./transport/bedrock-apps.fixture.js";
import { ScriptedBedrockClient, type BedrockReply } from "./transport/bedrock-provider.fixture.js";
import { transportApp } from "./transport/transport-app.js";

/**
 * #1231, the invariant of every provider path: what AGBoss records of one call — its cost, its
 * tokens, its host — is what the provider reported for it, once. The run's spend, the ledger's
 * entry and the budgets' charge all read that one record — for an agent without tools, an agent
 * with a tool (its model bound to it: acceptance H's doubled cost) and an agent with an output DTO
 * (its answer tool).
 */

const servers: SseServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** The agent the call is made for: how its model is bound. */
enum AgentKind {
  Text = "an agent without tools",
  Tool = "an agent with a tool",
  Structured = "an agent with an output DTO",
}

/** Where each kind's run starts (the desk of `workflowsOn`). */
const START: Readonly<Record<AgentKind, Class>> = {
  [AgentKind.Text]: ChatStart,
  [AgentKind.Tool]: LookupStart,
  [AgentKind.Structured]: VerdictStart,
};

/** The verdict agent's answer tool (`answer-<kebab of VerdictDto>`) and its answer. */
const ANSWER_TOOL = "answer-verdict-dto";
const VERDICT = { verdict: "guilty" };

/** What each kind's run finishes with. */
const OUTPUT: Readonly<Record<AgentKind, unknown>> = {
  [AgentKind.Text]: { text: "Hello there" },
  [AgentKind.Tool]: { text: "Hello there" },
  [AgentKind.Structured]: VERDICT,
};

/** What the provider reported for the call: what must be recorded. */
interface Wire {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly costSource: "api" | "price-table";
  readonly servedBy?: string;
}

type Parts = Partial<Parameters<typeof transportApp>[1]>;

/** One path: how its one call is made, on which application, with what on the wire. */
interface ProviderPath {
  readonly name: string;
  readonly application: Class;
  readonly wire: (kind: AgentKind) => Wire;
  readonly streamed: boolean;
  readonly parts: (kind: AgentKind) => Promise<Parts>;
  /** The run's output, when the path's answer is not the kind's usual one. */
  readonly output?: (kind: AgentKind) => unknown;
}

const { prompt_tokens: inputTokens = 0, completion_tokens: outputTokens = 0 } = WIRE_USAGE;
const WITHOUT_COST = { prompt_tokens: inputTokens, completion_tokens: outputTokens };

/** An HTTP provider over a 127.0.0.1 server: its stream in `shape`, its plain answer. */
const http =
  (shape: UsageShape, usage: WireUsage = WIRE_USAGE) =>
  async (kind: AgentKind): Promise<Parts> => {
    const server =
      kind === AgentKind.Structured
        ? await sseServer(
            [streamedToolCall(ANSWER_TOOL, VERDICT, shape, usage)],
            plainToolCallWithUsage(ANSWER_TOOL, VERDICT, usage),
          )
        : await sseServer(
            [streamWithUsage(["Hello", " there"], shape, usage)],
            plainWithUsage("Hello there", usage),
          );
    servers.push(server);
    return { send: server.send };
  };

/** A transport's answer for `kind`: the verdict agent's is its answer tool's call. */
const replyFor = (kind: AgentKind, response: ModelProviderResponse): BedrockReply =>
  kind === AgentKind.Structured
    ? ({ tools }) => ({
        ...response,
        text: "",
        toolCalls: [{ id: "c1", name: tools[0]?.name ?? "", arguments: VERDICT }],
      })
    : response;

/** A transport whose `complete()` answers `response` (the CLI providers' path too). */
const completing = (response: ModelProviderResponse) => (kind: AgentKind) =>
  Promise.resolve({ client: new ScriptedBedrockClient([replyFor(kind, response)]) });

/** A streaming transport's SDK whose `complete()` (a call with tools bound) gives the verdict. */
class VerdictStreamClient extends ScriptedStreamClient {
  override complete(invocation: StreamInvocation): Promise<ModelProviderResponse> {
    this.completed.push(invocation);
    return Promise.resolve({
      text: "",
      toolCalls: [{ id: "c1", name: ANSWER_TOOL, arguments: VERDICT }],
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  }
}

const API = {
  inputTokens,
  outputTokens,
  costUsd: WIRE_USAGE.cost ?? 0,
  costSource: "api",
} as const;
const MILLION = { inputTokens: 1_000_000, outputTokens: 500_000 };
const always = (wire: Wire) => (): Wire => wire;

const PATHS: readonly ProviderPath[] = [
  {
    name: "HTTP complete() — OpenRouter's usage.cost and host",
    application: StreamOpenRouterApplication,
    wire: always({ ...API, servedBy: WIRE_HOST }),
    streamed: false,
    parts: http(UsageShape.OwnChunk),
  },
  ...Object.values(UsageShape).map((shape) => ({
    name: `HTTP stream() — OpenRouter, ${shape}`,
    application: StreamOpenRouterApplication,
    wire: always({ ...API, servedBy: WIRE_HOST }),
    streamed: true,
    parts: http(shape),
  })),
  ...[UsageShape.OnFinishChoice, UsageShape.Repeated].map((shape) => ({
    name: `HTTP stream() — no usage.cost, tokens × prices, ${shape}`,
    application: StreamApplication,
    // 0.12M × $1 + 0.03M × $2 per million
    wire: always({ inputTokens, outputTokens, costUsd: usd(0.18), costSource: "price-table" }),
    streamed: true,
    parts: http(shape, WITHOUT_COST),
  })),
  {
    name: "transport complete() — the provider's exact cost",
    application: BedrockApplication,
    wire: always({ ...MILLION, costUsd: usd(0.25), costSource: "api" }),
    streamed: true,
    parts: completing({ text: "Hello there", usage: MILLION, cost: usd(0.25) }),
  },
  {
    name: "transport complete() — usage only, tokens × prices (the CLI providers' answer)",
    application: BedrockApplication,
    wire: always({ ...MILLION, costUsd: usd(10.5), costSource: "price-table" }), // 1M × $3 + 0.5M × $15
    streamed: false,
    parts: completing({ text: "Hello there", usage: MILLION }),
  },
  {
    name: "transport stream() — its usage promise, tokens × prices (with tools bound: complete())",
    application: TransportStreamApplication,
    // 1M × $1 + 0.5M × $2; a call with tools bound goes through complete(): 10 × $1 + 5 × $2 per million
    wire: (kind) =>
      kind === AgentKind.Text
        ? { ...MILLION, costUsd: usd(2), costSource: "price-table" }
        : { inputTokens: 10, outputTokens: 5, costUsd: usd(0.00002), costSource: "price-table" },
    streamed: true,
    parts: (kind) => {
      const Client = kind === AgentKind.Structured ? VerdictStreamClient : ScriptedStreamClient;
      return Promise.resolve({
        client: new ScriptedBedrockClient([]),
        overrides: new Map([[StreamSdkClient, new Client([streamOf(["Hello", " there"])])]]),
      });
    },
    output: (kind) => (kind === AgentKind.Tool ? { text: "whole" } : OUTPUT[kind]),
  },
];

/** The path's one call for `kind`: the run's spend and the ledger's view of it. */
async function callOn(path: ProviderPath, kind: AgentKind) {
  const ledger = new SeenLedger();
  const { overrides, client, ...parts } = await path.parts(kind);
  const app = await transportApp(path.application, {
    client: client ?? new ScriptedBedrockClient([]),
    ...parts,
    overrides: new Map([...(overrides ?? []), [CostLedgerRepository, ledger]]),
  });
  const done = await execute(
    app,
    START[kind],
    { text: "hi" },
    path.streamed ? { onStream: () => undefined } : undefined,
  );
  await app.close();
  return { done, ledger };
}

const CASES = PATHS.flatMap((path) =>
  Object.values(AgentKind).map((kind) => ({ name: `${path.name}, ${kind}`, path, kind })),
);

describe("#1231: every provider path records the wire's usage, once, for every kind of agent", () => {
  it.each(CASES)("$name", async ({ path, kind }) => {
    const wire = path.wire(kind);
    const { done, ledger } = await callOn(path, kind);

    expect(done.output).toEqual(path.output?.(kind) ?? OUTPUT[kind]);
    expect(done.spend.trace).toHaveLength(1);
    expect(done.spend.trace[0]).toMatchObject(wire);
    expect(done.spend.trace[0]?.servedBy).toBe(wire.servedBy);
    expect(done.spend.totalUsd).toBeCloseTo(wire.costUsd, 12);
    expect(ledger.entries).toEqual([expect.objectContaining(wire)]);
    expect(ledger.charged).toHaveLength(1);
    expect(ledger.charged[0]).toBeCloseTo(wire.costUsd, 12);
  });
});
