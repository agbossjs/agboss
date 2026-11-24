/**
 * #1319a (the outbound MCP client): `McpServerClient.call` — its options, its identity, its failures
 * (codes only), its bounds and its price, each rule on its own through a callable that stands for the
 * connected tool.
 */
import { describe, expect, it } from "vitest";
import {
  McpServerClient,
  callIdOf,
  type ServerToolCallable,
} from "../../src/components/mcp-client.js";
import { McpError } from "../../src/core/error-families/remote-errors.js";
import { AGBossError } from "../../src/core/errors.js";
import { Text } from "../../src/dto/index.js";
import { serviceUsageOf } from "../../src/components/spend-recorder.js";
import type { UsageRecord } from "../../src/finops/usage.js";
import { runInFrame } from "../../src/flow/context/frame.js";
import { ToolTimeoutError } from "../../src/tools/index.js";
import { ms, usd } from "../../src/units/index.js";
import { testFrame } from "../helpers/frame.js";
import { McpServer } from "../../src/components/decorators.js";
import { McpTransport } from "../../src/config/mcp-server-config.js";

class Ping {
  @Text() text!: string;
}

class Query {
  @Text() q!: string;
}

const tools = { ping: { output: Ping }, search: { input: Query, output: Ping } };

@McpServer({ name: "kb", transport: McpTransport.Stdio, command: "unused", tools })
class KbServer extends McpServerClient<typeof tools> {}

const ok = (value: unknown): ServerToolCallable => ({
  invoke: () => Promise.resolve({ kind: "ok", value }),
});

const connected = (
  callable: ServerToolCallable,
  wiring: Parameters<KbServer["attachServer"]>[0] = { name: "kb" },
): KbServer => {
  const server = new KbServer();
  server.attachServerTools(
    new Map([
      ["ping", callable],
      ["search", callable],
    ]),
  );
  server.attachServer(wiring);
  return server;
};

describe("#1319a: a call's arguments", () => {
  it("a tool without input is called with the options alone, and gets no arguments", async () => {
    let got: unknown;
    const server = connected({
      invoke: (raw) => {
        got = raw;
        return Promise.resolve({ kind: "ok", value: { text: "pong" } });
      },
    });

    expect(await server.call("ping")).toEqual({ text: "pong" });
    expect(await server.call("ping", { key: "again" })).toEqual({ text: "pong" });
    expect(got).toEqual({});
  });

  it("a tool with input is called with its arguments and then the options", async () => {
    let got: unknown;
    const server = connected({
      invoke: (raw) => {
        got = raw;
        return Promise.resolve({ kind: "ok", value: { text: "hit" } });
      },
    });

    await server.call("search", { q: "x" }, { key: "k-1" });

    expect(got).toEqual({ q: "x" });
  });

  it("is a rejection, never a throw, whatever is wrong", async () => {
    const server = new KbServer();

    await expect(server.call("ping")).rejects.toBeInstanceOf(McpError.MethodNotFound);
  });

  it("refuses a key that breaks the charset, before anything is sent", async () => {
    let sent = 0;
    const server = connected({
      invoke: () => {
        sent += 1;
        return Promise.resolve({ kind: "ok", value: { text: "x" } });
      },
    });

    for (const key of ["", " a", "a b", "-a", "a".repeat(41), "a/b"])
      await expect(server.call("ping", { key })).rejects.toBeInstanceOf(McpError.Contract);
    await expect(server.call("ping", { key: "a".repeat(40) })).resolves.toEqual({ text: "x" });
    expect(sent).toBe(1);
  });
});

describe("#1319a: a failed call (codes only)", () => {
  it("passes an AGBoss error as it is: a tool timeout, a limit, a lost lease", async () => {
    const timeout = new ToolTimeoutError({ timeout: ms(5) });
    const server = connected({
      invoke: () => Promise.resolve({ kind: "error", message: timeout.message, cause: timeout }),
    });

    await expect(server.call("ping")).rejects.toBe(timeout);
  });

  it("is McpError.Unavailable when the server or its wire failed, never with their words", async () => {
    const server = connected({
      invoke: () =>
        Promise.resolve({
          kind: "error",
          message: "denied for alice@example.com",
          cause: new Error("denied for alice@example.com"),
        }),
    });

    const failure = await server.call("ping").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(McpError.Unavailable);
    expect(failure).toBeInstanceOf(AGBossError);
    expect((failure as Error).message).not.toContain("alice");
  });

  it("is McpError.Contract when the arguments or the result broke the declared DTOs", async () => {
    const server = connected({
      invoke: () => Promise.resolve({ kind: "error", message: "invalid output: text: x" }),
    });

    await expect(server.call("ping")).rejects.toBeInstanceOf(McpError.Contract);
  });
});

describe("#1319a: the bounds of a call", () => {
  it("ends with the signal the call is given", async () => {
    const abort = new AbortController();
    const server = connected({
      invoke: (_raw, ctx) =>
        new Promise((_resolve, reject) => {
          if (ctx.signal.aborted) reject(ctx.signal.reason as Error);
          ctx.signal.addEventListener("abort", () => {
            reject(ctx.signal.reason as Error);
          });
        }),
    });

    const call = server.call("ping", { signal: abort.signal });
    abort.abort(new Error("stop"));

    await expect(call).rejects.toThrow("stop");
  });

  it("ends with the running step's signal when it is given none", async () => {
    const abort = new AbortController();
    const spec = testFrame();
    const server = connected({
      invoke: (_raw, ctx) =>
        Promise.resolve({
          kind: "ok",
          value: { text: String(ctx.signal === spec.execution.signal) },
        }),
    });
    const frame = { ...spec, execution: { ...spec.execution, signal: abort.signal } };

    const result = await runInFrame(frame, () => server.call("ping"));

    expect(result).toEqual({ text: "false" }); // a derived signal, never a signal nobody can abort
  });

  it("a call's timeout ends it with a ToolTimeoutError", async () => {
    const server = connected({
      invoke: (_raw, ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => {
            reject(ctx.signal.reason as Error);
          });
        }),
    });

    await expect(server.call("ping", { timeout: ms(20) })).rejects.toBeInstanceOf(ToolTimeoutError);
  });

  it("maxConcurrentCalls lets that many through at once, the rest wait in order", async () => {
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    const server = connected(
      {
        invoke: async (raw) => {
          running += 1;
          peak = Math.max(peak, running);
          order.push((raw as { n: number }).n);
          await new Promise((resolve) => setImmediate(resolve));
          running -= 1;
          return { kind: "ok", value: { text: "x" } };
        },
      },
      { name: "kb", maxConcurrentCalls: 1 },
    );

    await Promise.all([0, 1, 2, 3].map((n) => server.call("search", { q: String(n), n } as never)));

    expect(peak).toBe(1);
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it("refuses maxConcurrentCalls that is no whole number from 1 when it is attached", () => {
    for (const limit of [0, -1, 1.5, Number.NaN])
      expect(() => connected(ok({}), { name: "kb", maxConcurrentCalls: limit })).toThrow(
        "[mcp.max-concurrent-calls-invalid]",
      );
  });
});

describe("#1319a: a call's identity and price", () => {
  const inStep = <T>(work: () => Promise<T>, reported: UsageRecord[] = []): Promise<T> =>
    runInFrame(
      { ...testFrame(), services: { reportUsage: (usage: UsageRecord) => reported.push(usage) } },
      work,
    );

  it("callId is made of the step, the server, the tool and the key: distinct per call, the same on a replay", async () => {
    const ids = await inStep(() =>
      Promise.resolve([
        callIdOf("kb", "ping", undefined),
        callIdOf("kb", "ping", "second"),
        callIdOf("kb", "search", undefined),
        callIdOf("other", "ping", undefined),
        callIdOf("kb", "ping", undefined),
      ]),
    );

    expect(new Set(ids.slice(0, 4)).size).toBe(4);
    expect(ids[4]).toBe(ids[0]);
    expect(callIdOf("kb", "ping", undefined)).toBeUndefined(); // outside a step
  });

  it("costPerCall is charged once per successful call as the service mcp:<server>, under the call's ledger id", async () => {
    const reported: UsageRecord[] = [];
    const server = connected(ok({ text: "x" }), { name: "kb", costPerCall: usd(0.25) });

    await inStep(() => server.call("ping"), reported);

    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({
      ...serviceUsageOf({ service: "mcp:kb", cost: usd(0.25) }),
      ledgerKey: { id: expect.stringMatching(/^mcp:[0-9a-f]{64}:cost$/) as string },
    });
  });

  it("charges nothing for a failed call, a free server, or a call outside a step", async () => {
    const reported: UsageRecord[] = [];
    const failing = connected(
      { invoke: () => Promise.resolve({ kind: "error", message: "x", cause: new Error("x") }) },
      { name: "kb", costPerCall: usd(1) },
    );
    const free = connected(ok({ text: "x" }), { name: "kb" });
    const priced = connected(ok({ text: "x" }), { name: "kb", costPerCall: usd(1) });

    await inStep(() => failing.call("ping"), reported).catch(() => undefined);
    await inStep(() => free.call("ping"), reported);
    await priced.call("ping");

    expect(reported).toEqual([]);
  });

  it("refuses a price that is no amount when it is attached, never after a call ran", () => {
    for (const price of [-1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => connected(ok({}), { name: "kb", costPerCall: price as never })).toThrow();
  });
});
