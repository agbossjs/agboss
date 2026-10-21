import { PauseAnswerer } from "../../src/channels/channel-role.decorator.js";
import "../../src/testing/setup.js";
import { writeFile } from "node:fs/promises";
import http, { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  replyWith,
  callTool,
  routeTo,
  LiveCallBlockedError,
  testWith,
} from "../../src/testing/index.js";
import {
  ChatStart,
  MainRouter,
  NOTES_DIR,
  NotesServer,
  ReadNote,
  Reply,
  SaveNote,
  Support,
  Writer,
  DeskApplication,
} from "./fixtures/desk.workflow.js";
import { toolResultsOf } from "./fixtures/requests.js";
import { execute } from "../helpers/flow.js";

const test = testWith(DeskApplication);
const local = testWith(DeskApplication, { allowNetwork: ["localhost"] });
const realNotes = testWith(DeskApplication, { real: [NotesServer] });

const unguardedFetch = globalThis.fetch;
const unguardedGet = http.get;
let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((_request, response) => response.end("local ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  port = typeof address === "object" && address !== null ? address.port : 0;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("AC12: everything external is replaced; a live call fails the test before the call", () => {
  test("an agent without a script is a blocked live model call, naming its class", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(MainRouter).thenReturn(routeTo(Writer));

    const run = execute(app, ChatStart, { text: "hi" });

    await expect(run).rejects.toThrow(/Writer has no script/);
  });

  test("a model provider's host is never reached: fetch to it is blocked", async () => {
    const call = fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST" });

    await expect(call).rejects.toBeInstanceOf(LiveCallBlockedError);
    await expect(call).rejects.toThrow(/fetch to openrouter.ai — the network is blocked/);
  });

  test("node:http requests are blocked too, before they leave the process", () => {
    expect(() => http.get("http://example.com/")).toThrow(/http.get to example.com/);
  });

  test("an MCP server tool without a stub fails the run with the tool's name", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(MainRouter).thenReturn(routeTo(Support));
    mockLlm(Support).thenReturn(callTool(ReadNote, { title: "n1" }), replyWith("Read."));

    await expect(execute(app, ChatStart, { text: "read n1" })).rejects.toThrow(
      /test.live-call-blocked: MCP server "notes" tool "read_text_file" has no stub; add mcpOf\(NotesServer\)/,
    );
  });

  test("a stubbed MCP server answers through its handlers", async ({ app, mockLlm, mcpOf }) => {
    mockLlm(MainRouter).thenReturn(routeTo(Support));
    mockLlm(Support).thenReturn(callTool(ReadNote, { title: "n1" }), replyWith("Call back."));
    mcpOf(NotesServer).thenReturn({
      read_text_file: () => Promise.resolve({ content: "call back" }),
    });

    const result = await execute(app, ChatStart, { text: "read n1" });

    expect(result).toFinishWith(Reply, { text: "Call back." });
    expect(toolResultsOf(mockLlm(Support).lastRequest)).toEqual(['{"text":"call back"}']);
  });

  local('allowNetwork: ["localhost"] lets a request to 127.0.0.1 through', async () => {
    const response = await fetch(`http://127.0.0.1:${String(port)}/`);

    expect(await response.text()).toBe("local ok");
  });

  local("allowNetwork keeps every other host blocked", async () => {
    await expect(fetch("https://example.com/")).rejects.toThrow(/fetch to example.com/);
  });

  it("outside a workflow test the network is not guarded", () => {
    expect(globalThis.fetch).toBe(unguardedFetch);
    expect(http.get).toBe(unguardedGet);
  });

  realNotes(
    "real: [NotesServer] keeps the MCP server real — a real process, its real file",
    async ({ app }) => {
      await writeFile(join(NOTES_DIR, "real-note.md"), "from disk");

      const read = await app.tool(ReadNote).invoke({ title: "real-note" });

      expect(read).toEqual({ kind: "ok", value: { text: "from disk" } });
    },
    30_000,
  );

  test("a write tool still waits for approval with stubs in place", async ({ app, mockLlm }) => {
    mockLlm(MainRouter).thenReturn(routeTo(Support));
    mockLlm(Support).thenReturn(callTool(SaveNote, { title: "n2", text: "x" }));

    const result = await execute(app, ChatStart, { text: "save" });

    expect(result).toHavePausedAt(Support);
    expect(result.pending).toEqual([
      {
        pauseId: expect.stringMatching(/^[0-9a-f]{32}$/),
        answeredBy: PauseAnswerer.ThreadOwner,
        agent: "support-agent",
        channel: "terminal-user-channel",
        childExecutionId: undefined,
        itemIndex: undefined,
        ask: {
          callId: "call-1",
          tool: "save-note-tool",
          arguments: { title: "n2", text: "x" },
          summary: expect.any(String),
        },
      },
    ]);
  });
});
