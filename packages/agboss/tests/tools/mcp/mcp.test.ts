import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { McpTransport } from "../../../src/config/mcp-server-config.js";
import { McpError } from "../../../src/core/error-families/remote-errors.js";
import { bearer, defineEnv } from "../../../src/environments/define-env.js";
import { env } from "../../../src/environments/env-readers.js";
import { secret } from "../../../src/environments/secret.js";
import { defaultTransport } from "../../../src/tools/mcp/connect.js";
import { resolvedServerOf } from "../../../src/tools/mcp/resolve.js";
import {
  connectMcpServers,
  mcpResultValue,
  mcpServer,
  schemaDifferences,
} from "../../../src/tools/index.js";
import { fakeMcpServer, type FakeTool } from "./fake-server.js";

const ctx = { signal: new AbortController().signal, reportCost: vi.fn() };
const stdio = { transport: McpTransport.Stdio as const, command: "unused" };

const repoPrs: FakeTool = {
  name: "list_pull_requests",
  inputSchema: {
    properties: { owner: { type: "string" }, repo: { type: "string" }, state: { type: "string" } },
    required: ["owner", "repo"],
  },
  outputSchema: { properties: { count: { type: "number" } } },
  call: (args) => ({
    content: [{ type: "text", text: "{}" }],
    structuredContent: { count: String(args.repo).length },
  }),
};

const declare = () => {
  const github = mcpServer("github");
  const prs = github.tool({
    tool: "list_pull_requests",
    description: "PR count",
    input: z.object({ owner: z.string(), repo: z.string() }),
    output: z.object({ count: z.number() }),
  });
  return { github, prs };
};

const connect = async (tools: FakeTool[], facades: ReturnType<typeof declare>) => {
  const transport = await fakeMcpServer(tools);
  return connectMcpServers({ github: stdio }, [facades.github], [facades.prs], {}, () => transport);
};

describe("MCP facades", () => {
  it("are typed tools named <server>__<tool> that call the server", async () => {
    const facades = declare();
    const connections = await connect([repoPrs], facades);

    expect(facades.prs.name).toBe("github__list_pull_requests");
    expect(await facades.prs.invoke({ owner: "o", repo: "abcd" }, ctx)).toEqual({
      kind: "ok",
      value: { count: 4 },
    });
    await connections.close();
  });

  it("maps structuredContent, JSON text and raw text; server errors become messages", () => {
    const object = z.object({ a: z.number() });
    expect(mcpResultValue({ content: [], structuredContent: { a: 1 } }, object)).toEqual({ a: 1 });
    expect(mcpResultValue({ content: [{ type: "text", text: '{"a":2}' }] }, object)).toEqual({
      a: 2,
    });
    expect(mcpResultValue({ content: [{ type: "text", text: "hello" }] }, z.string())).toBe(
      "hello",
    );
    expect(() =>
      mcpResultValue({ isError: true, content: [{ type: "text", text: "denied" }] }, object),
    ).toThrow(McpError.Unavailable);
    // the server's own words never reach the error
    expect(() =>
      mcpResultValue({ isError: true, content: [{ type: "text", text: "denied" }] }, object),
    ).not.toThrow(/denied/);
    expect(() =>
      mcpResultValue({ content: [{ type: "text", text: "{not json" }] }, object),
    ).toThrow(McpError.Contract);
    expect(() => mcpResultValue({ content: 42 }, object)).toThrow(McpError.Contract);
  });

  it("turns server errors and bad output into error results", async () => {
    const facades = declare();
    const failing: FakeTool = {
      ...repoPrs,
      call: () => ({ content: [{ type: "text", text: "rate limited" }], isError: true }),
    };
    const connections = await connect([failing], facades);

    const failed = await facades.prs.invoke({ owner: "o", repo: "r" }, ctx);

    expect(failed).toMatchObject({ kind: "error", cause: expect.any(McpError.Unavailable) });
    expect(JSON.stringify(failed)).not.toContain("rate limited");
    await connections.close();
  });

  it("is unavailable before connection and after close", async () => {
    const facades = declare();

    expect(await facades.prs.invoke({ owner: "o", repo: "r" }, ctx)).toMatchObject({
      kind: "error",
      cause: expect.any(McpError.Unavailable) as unknown,
    });
  });
});

describe("connectMcpServers", () => {
  it("does nothing when no facade uses a server", async () => {
    const connections = await connectMcpServers(undefined, [mcpServer("unused")], [], {});

    await expect(connections.close()).resolves.toBeUndefined();
  });

  it("fails startup when a used server is not configured", async () => {
    const { github, prs } = declare();

    await expect(connectMcpServers({}, [github], [prs], {})).rejects.toThrow(McpError.Unavailable);
  });

  it("fails startup when a server cannot be reached", async () => {
    const { github, prs } = declare();
    const http = { transport: McpTransport.Http as const, url: "http://127.0.0.1:9/mcp" };

    await expect(connectMcpServers({ github: http }, [github], [prs], {})).rejects.toThrow(
      McpError.Unavailable,
    );
  });

  it("checks only the input when the server declares no output schema", async () => {
    const facades = declare();
    const withoutOutput: FakeTool = {
      name: repoPrs.name,
      inputSchema: repoPrs.inputSchema,
      call: repoPrs.call,
    };
    const connections = await connect([withoutOutput], facades);

    expect(await facades.prs.invoke({ owner: "o", repo: "ab" }, ctx)).toEqual({
      kind: "ok",
      value: { count: 2 },
    });
    await connections.close();
  });

  it("reports contract drift with tool and difference", async () => {
    const facades = declare();
    const drifted: FakeTool = {
      ...repoPrs,
      inputSchema: {
        properties: { owner: { type: "string" }, repository: { type: "string" } },
        required: ["owner", "repository"],
      },
    };

    const failure = await connect([drifted], facades).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(McpError.Contract);
    // our tool and the kind of difference; never the server's own property names
    expect(String(failure)).toContain(
      "github__list_pull_requests (github.list_pull_requests): input differs",
    );
    expect(String(failure)).not.toContain("repository");
  });

  it("reports a tool missing on the server and output drift", async () => {
    const facades = declare();
    const outputDrift: FakeTool = {
      ...repoPrs,
      outputSchema: { properties: { count: { type: "string" } } },
    };

    await expect(connect([], facades)).rejects.toThrow("tool not found on the server");
    await expect(connect([outputDrift], declare())).rejects.toThrow(
      "github__list_pull_requests (github.list_pull_requests): output differs",
    );
  });
});

const appEnv = defineEnv({
  ghToken: secret("GH_TOKEN"),
  gate: secret.optional("GATE_TOKEN"),
  url: env("MCP_URL"),
  proxy: env.optional("MCP_PROXY"),
});

describe("resolvedServerOf: the references of a declaration", () => {
  it("reads a stdio server's command, args and env from the process environment", () => {
    const resolved = resolvedServerOf(
      "gh",
      {
        transport: McpTransport.Stdio,
        command: "x",
        args: ["--url", appEnv.url],
        env: { GH_TOKEN: appEnv.ghToken, GATE: appEnv.gate, PROXY: appEnv.proxy, FIXED: "1" },
      },
      { PATH: "/bin", HOME: "/h", GH_TOKEN: "t", MCP_URL: "http://u", SECRET_OTHER: "no" },
    );

    expect(resolved).toEqual({
      transport: McpTransport.Stdio,
      command: "x",
      args: ["--url", "http://u"],
      // an optional entry that is unset is left out; the system variables are inherited
      env: { PATH: "/bin", HOME: "/h", GH_TOKEN: "t", FIXED: "1" },
    });
  });

  it("does not pass the system variables on with inheritSystemEnv: false", () => {
    const resolved = resolvedServerOf(
      "gh",
      { transport: McpTransport.Stdio, command: "x", inheritSystemEnv: false },
      { PATH: "/bin" },
    );

    expect(resolved).toMatchObject({ env: {} });
  });

  it("reads an http server's url and headers; a bearer header is Bearer <secret>", () => {
    const resolved = resolvedServerOf(
      "api",
      {
        transport: McpTransport.Http,
        url: appEnv.url,
        headers: { Authorization: bearer(appEnv.ghToken), "X-Plain": "p" },
      },
      { MCP_URL: "http://x/mcp", GH_TOKEN: "t" },
    );

    expect(resolved).toEqual({
      transport: McpTransport.Http,
      url: "http://x/mcp",
      headers: { Authorization: "Bearer t", "X-Plain": "p" },
    });
  });

  it("names a missing variable, never a value", () => {
    expect(() =>
      resolvedServerOf(
        "gh",
        { transport: McpTransport.Stdio, command: "x", env: { T: appEnv.ghToken } },
        {},
      ),
    ).toThrow("GH_TOKEN is not set");
  });

  it("refuses an url that is none", () => {
    expect(() =>
      resolvedServerOf("api", { transport: McpTransport.Http, url: "not a url" }, {}),
    ).toThrow(McpError.Unavailable);
  });
});

describe("defaultTransport", () => {
  it("builds the transports of a resolved server", () => {
    const headers = () => Promise.resolve({});

    expect(
      defaultTransport(
        "gh",
        { transport: McpTransport.Stdio, command: "x", args: [], env: { T: "1" } },
        headers,
      ),
    ).toBeDefined();
    expect(
      defaultTransport(
        "api",
        { transport: McpTransport.Http, url: "http://x/mcp", headers: { Authorization: "v" } },
        headers,
      ),
    ).toBeDefined();
  });
});

describe("schemaDifferences", () => {
  it("accepts compatible schemas and tolerates servers without properties", () => {
    expect(
      schemaDifferences(
        { properties: { a: { type: "string" } } },
        { properties: { a: { type: "string" }, b: {} } },
      ),
    ).toEqual([]);
    expect(schemaDifferences("not a schema", {})).toEqual([]);
  });
});
