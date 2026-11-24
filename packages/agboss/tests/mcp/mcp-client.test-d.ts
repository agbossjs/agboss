/**
 * #1319a, at compile time: `McpServerClient.call` is typed by the declared tools — arguments required
 * where a tool declares `input`, none where it does not — and the forms 0.1.1 removed do not compile.
 */
import { describe, expectTypeOf, it } from "vitest";
import { McpServer } from "../../src/components/decorators.js";
import {
  McpServerClient,
  type ArgumentsOf,
  type McpCallArguments,
  type McpCallOptions,
} from "../../src/components/mcp-client.js";
import { McpTransport } from "../../src/config/mcp-server-config.js";
import { McpError } from "../../src/core/error-families/remote-errors.js";
import { Text } from "../../src/dto/index.js";
import { Workflow } from "../../src/index.js";
import type { Milliseconds } from "../../src/units/index.js";

class Query {
  @Text() q!: string;
}
class Reply {
  @Text() text!: string;
}

const tools = { ping: { output: Reply }, search: { input: Query, output: Reply } };
type Tools = typeof tools;

@McpServer({ name: "kb", transport: McpTransport.Stdio, command: "x", tools })
class KbServer extends McpServerClient<Tools> {}

describe("#1319a: McpServerClient.call", () => {
  it("a tool without input has no arguments; one with input requires them", () => {
    expectTypeOf<ArgumentsOf<Tools["ping"]>>().toEqualTypeOf<undefined>();
    expectTypeOf<ArgumentsOf<Tools["search"]>>().toEqualTypeOf<Query>();
    expectTypeOf<McpCallArguments<Tools["ping"]>>().toEqualTypeOf<[options?: McpCallOptions]>();
    expectTypeOf<McpCallArguments<Tools["search"]>>().toEqualTypeOf<
      [args: Query, options?: McpCallOptions]
    >();
  });

  it("returns the declared output and takes the options", () => {
    const server = new KbServer();

    expectTypeOf(server.call("ping")).resolves.toEqualTypeOf<Reply>();
    expectTypeOf(
      server.call("ping", { key: "k", timeout: 1 as Milliseconds }),
    ).resolves.toEqualTypeOf<Reply>();
    expectTypeOf(
      server.call("search", { q: "x" }, { signal: new AbortController().signal }),
    ).resolves.toEqualTypeOf<Reply>();
    expectTypeOf<McpCallOptions>().toEqualTypeOf<{
      readonly key?: string;
      readonly signal?: AbortSignal;
      readonly timeout?: Milliseconds;
    }>();
  });

  it("a wrong call does not compile", () => {
    const server = new KbServer();

    // @ts-expect-error — a tool with input needs its arguments
    void server.call("search");
    // @ts-expect-error — the arguments are checked against the declared input
    void server.call("search", { q: 1 });
    // @ts-expect-error — a tool without input takes no arguments, only options
    void server.call("ping", { q: "x" });
    // @ts-expect-error — only the declared tools
    void server.call("missing");
    // @ts-expect-error — the signal is an option now, not a third argument
    void server.call("search", { q: "x" }, new AbortController().signal);
  });
});

describe("#1319a: the removed forms do not compile", () => {
  it("a transport is the enum, not its text", () => {
    McpServer({
      name: "kb",
      // @ts-expect-error — McpTransport.Stdio, not "stdio"
      transport: "stdio",
      command: "x",
      tools,
    });
    McpServer({
      name: "kb",
      transport: McpTransport.Stdio,
      command: "x",
      // @ts-expect-error — a variable is a defineEnv reference now, not a list of names
      env: ["TOKEN"],
      tools,
    });
    McpServer({
      name: "kb",
      transport: McpTransport.Stdio,
      command: "x",
      // @ts-expect-error — the target's `endpoint`, not its `expose`
      target: { application: "a", expose: "e" },
      tools,
    });
  });

  it("a workflow lists no MCP servers", () => {
    Workflow({
      name: "x-workflow",
      version: "1",
      flow: [],
      // @ts-expect-error — `mcp` is gone: a tool lists the server in its `deps`
      mcp: [KbServer],
    });
  });

  it("its errors are McpError variants", () => {
    expectTypeOf<
      InstanceType<typeof McpError.MethodNotFound>["code"]
    >().toEqualTypeOf<"mcp.method-not-found">();
  });
});
