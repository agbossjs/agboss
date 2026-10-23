import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defaultTransport } from "../../../src/tools/mcp/connect.js";
import {
  connectMcpServers,
  mcpResultValue,
  mcpServer,
  McpContractError,
  McpUnavailableError,
  schemaDifferences,
} from "../../../src/tools/index.js";
import { fakeMcpServer, type FakeTool } from "./fake-server.js";

const ctx = { signal: new AbortController().signal, reportCost: vi.fn() };
const stdio = { transport: "stdio" as const, command: "unused" };

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
    ).toThrow("denied");
    expect(() => mcpResultValue({ isError: true }, object)).toThrow("MCP tool reported an error");
  });

  it("turns server errors and bad output into error results", async () => {
    const facades = declare();
    const failing: FakeTool = {
      ...repoPrs,
      call: () => ({ content: [{ type: "text", text: "rate limited" }], isError: true }),
    };
    const connections = await connect([failing], facades);

    expect(await facades.prs.invoke({ owner: "o", repo: "r" }, ctx)).toEqual({
      kind: "error",
      message: "rate limited",
      cause: expect.any(Error) as unknown,
    });
    await connections.close();
  });

  it("is unavailable before connection and after close", async () => {
    const facades = declare();

    expect(await facades.prs.invoke({ owner: "o", repo: "r" }, ctx)).toMatchObject({
      kind: "error",
      message: 'MCP server "github" is not connected',
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

    await expect(connectMcpServers({}, [github], [prs], {})).rejects.toThrow(McpUnavailableError);
  });

  it("fails startup when a server cannot be reached", async () => {
    const { github, prs } = declare();
    const http = { transport: "http" as const, url: "http://127.0.0.1:9/mcp" };

    await expect(connectMcpServers({ github: http }, [github], [prs], {})).rejects.toThrow(
      /Cannot connect to MCP server "github"/,
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

    expect(failure).toBeInstanceOf(McpContractError);
    expect(String(failure)).toContain(
      'github__list_pull_requests (github.list_pull_requests) input: server requires "repository"',
    );
    expect(String(failure)).toContain('facade declares "repo", server does not know it');
  });

  it("reports a tool missing on the server and output drift", async () => {
    const facades = declare();
    const outputDrift: FakeTool = {
      ...repoPrs,
      outputSchema: { properties: { count: { type: "string" } } },
    };

    await expect(connect([], facades)).rejects.toThrow("tool not found on the server");
    await expect(connect([outputDrift], declare())).rejects.toThrow(
      'output: "count": facade type "number", server type "string"',
    );
  });
});

describe("defaultTransport", () => {
  it("requires env variables by name for stdio and http", () => {
    expect(() =>
      defaultTransport("gh", { transport: "stdio", command: "x", env: ["GH_TOKEN"] }, {}),
    ).toThrow("needs env variable GH_TOKEN");
    expect(() =>
      defaultTransport(
        "api",
        { transport: "http", url: "http://x/mcp", headers: { Authorization: "API_KEY" } },
        {},
      ),
    ).toThrow("needs env variable API_KEY");
  });

  it("builds transports when env variables are present", () => {
    expect(
      defaultTransport("gh", { transport: "stdio", command: "x", env: ["T"] }, { T: "1" }),
    ).toBeDefined();
    expect(
      defaultTransport(
        "api",
        { transport: "http", url: "http://x/mcp", headers: { Authorization: "K" } },
        { K: "v" },
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
