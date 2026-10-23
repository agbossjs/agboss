import { describe, expect, it } from "vitest";
import { mcpServerStub } from "../../src/testing/index.js";
import { toolOf, workflowOf } from "../../src/testing/index.js";
import { connectMcpServers, type ToolInvocationContext } from "../../src/tools/index.js";
import { resolveTools, type WorkflowServices } from "../../src/workflow.js";
import { fakeMcpServer, type FakeTool } from "../tools/mcp/fake-server.js";
import { FilesServer, Greetings, ReadFile } from "./fixture/components.js";

const ctx: ToolInvocationContext = {
  signal: new AbortController().signal,
  reportCost: () => undefined,
};
const services: WorkflowServices = {
  router: (name) => ({ name, route: () => Promise.reject(new Error("unused")) }),
};
const readTool: FakeTool = {
  name: "read",
  inputSchema: { properties: { path: { type: "string" } }, required: ["path"] },
  call: (args) => ({ content: [{ type: "text", text: `contents of ${String(args.path)}` }] }),
};

describe("MCP tools: a tool with its server's client injected (#109)", () => {
  it("AC1: one class — metadata, the server through the constructor, behaviour in run (tested with a stub)", async () => {
    const files = mcpServerStub(FilesServer, {
      read: ({ path }) => Promise.resolve({ text: `stub ${path}` }),
    });

    expect(await toolOf(new ReadFile(files)).invoke({ path: "a.md" }, ctx)).toEqual({
      kind: "ok",
      value: { text: "stub a.md" },
    });
  });

  it("AC1: in a workflow, the container injects the connected server; the call goes to the real server", async () => {
    const workflow = await workflowOf(Greetings);
    const transport = await fakeMcpServer([readTool]);
    await connectMcpServers(
      { files: { transport: "stdio", command: "unused" } },
      workflow.mcpServers,
      workflow.serverTools ?? [],
      {},
      () => transport,
    );
    const read = resolveTools(workflow, services).find((tool) => tool.name === "read-file-tool");

    expect(workflow.serverTools?.map((tool) => tool.name)).toEqual(["files__read"]);
    expect(await read?.invoke({ path: "notes.md" }, ctx)).toEqual({
      kind: "ok",
      value: { text: "contents of notes.md" },
    });
  });

  it("AC2: a declared server tool missing on the server stops startup, naming it", async () => {
    const workflow = await workflowOf(Greetings);
    const transport = await fakeMcpServer([]);

    await expect(
      connectMcpServers(
        { files: { transport: "stdio", command: "unused" } },
        workflow.mcpServers,
        workflow.serverTools ?? [],
        {},
        () => transport,
      ),
    ).rejects.toThrow(/read.*tool not found on the server/);
  });
});
