import { HumanMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { McpServerClient } from "../../src/mcp/index.js";
import { GuardFailedError } from "../../src/graph/errors.js";
import type { ResolvedModelSettings } from "../../src/config/types.js";
import {
  replyWith,
  routeTo,
  TestFailure,
  TestSetupError,
  testWith,
  UNSCRIPTED_SUMMARY,
} from "../../src/testing/index.js";
import { millisecondsOf, VirtualClock, type ClockDuration } from "../../src/testing/clock.js";
import { TestEnvironment } from "../../src/testing/environment.js";
import { asError } from "../../src/testing/errors.js";
import { failureFactsOf, nodeNameOf } from "../../src/testing/failure-facts.js";
import { fetchHostOf, hostOf, isHostAllowed } from "../../src/testing/network-guard.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { chatKeyOf, createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { usd } from "../../src/units/index.js";
import { ChatStart, Reply, Writer, DeskApplication } from "./fixtures/desk.workflow.js";

const free: ResolvedModelSettings = {
  model: "test/free",
  temperature: 0,
  maxTokens: 100,
  price: { inputPerMTok: 0, outputPerMTok: 0 },
};
const request = { input: "x", options: [{ name: "a", description: "A" }] };

describe("AC12: the clock, ids and errors of a test", () => {
  it("durations carry their unit; anything else is a setup error", async () => {
    const clock = new VirtualClock(new Date("2026-01-01T00:00:00.000Z"));
    await clock.advance("1.5s");

    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:01.500Z");
    expect([millisecondsOf("2d"), millisecondsOf("5m"), millisecondsOf("10ms")]).toEqual([
      172_800_000, 300_000, 10,
    ]);
    expect(() => millisecondsOf("25 hours" as ClockDuration)).toThrow(TestSetupError);
  });

  it("anything thrown becomes an Error", () => {
    expect(asError("plain").message).toBe("plain");
  });

  it("a script past its end names how many turns it had", () => {
    const script = new ScriptBook()
      .scriptOf("agent:writer")
      .thenReturn(replyWith("1"), replyWith("2"));
    script.next();
    script.next();

    expect(() => script.next()).toThrow("2 turns scripted, asked for #3");
  });
});

describe("AC12: the network guard reads every way a request names its host", () => {
  it("allows a host when listed; localhost covers every loopback address", () => {
    expect(isHostAllowed(["localhost"], "::1")).toBe(true);
    expect(isHostAllowed(["api.example.org"], "api.example.org")).toBe(true);
    expect(isHostAllowed(["api.example.org"], "example.org")).toBe(false);
  });

  it("finds the host of a URL string, a URL, request options and a Request", () => {
    expect(hostOf("https://a.example/x")).toBe("a.example");
    expect(hostOf(new URL("http://b.example"))).toBe("b.example");
    expect(hostOf({ hostname: "c.example" })).toBe("c.example");
    expect(hostOf({ host: "d.example:8080" })).toBe("d.example");
    expect(hostOf({})).toBe("localhost");
    expect(fetchHostOf(new Request("https://e.example/"))).toBe("e.example");
  });
});

describe("AC12: failures name their codes and nodes", () => {
  it("reads a guard's failure, a named node, and nothing from a non-error", () => {
    expect(failureFactsOf(new GuardFailedError("pii", [], "down")).nodes).toEqual(["pii"]);
    expect(failureFactsOf("not an error")).toEqual({ codes: [], nodes: [] });
    expect(nodeNameOf(Writer)).toBe("writer-agent");
  });
});

describe("AC12: the scripted gateway on its own", () => {
  it("keys chat models by their user", () => {
    expect(chatKeyOf({ kind: "router", router: "r" })).toBe("router:r");
    expect(chatKeyOf({ kind: "compaction" })).toBe("compaction");
  });

  it("prices a decision on a chat-model router and reads requests without instructions", async () => {
    const book = new ScriptBook();
    book.scriptOf("router:r").thenReturn(routeTo(Writer, { cost: usd(0.01) }));
    const gateway = createScriptedGateway(book);
    const options = [{ name: "writer-agent", description: "W" }];

    const outcome = await gateway.routeTo({
      router: "r",
      model: { kind: "llm", settings: free },
      request: { input: "x", options },
    });

    expect(outcome).toMatchObject({
      kind: "decided",
      usage: { model: "test/free", costUsd: 0.01 },
    });
    expect(book.scriptOf("router:r").onlyRequest).toMatchObject({ instructions: "" });
  });

  it("a router scripted with an replyWith, or an agent with a decision, is a wrong script", async () => {
    const book = new ScriptBook();
    book.scriptOf("router:r").thenReturn(replyWith("text"));
    book.scriptOf("agent:a").thenReturn(routeTo(Writer));
    const gateway = createScriptedGateway(book);

    const routed = await gateway.routeTo({
      router: "r",
      model: { kind: "jev", model: "j" },
      request,
    });
    const chat = gateway.chatModel({ user: { kind: "agent", agent: "a" }, settings: free });

    expect(routed.kind === "failed" && routed.reason).toContain("is a router");
    await expect(chat.invoke([new HumanMessage("hi")])).rejects.toBeInstanceOf(TestFailure);
    expect(book.takeFailure()?.message).toContain("is a router");
  });

  it("an unscripted compaction writes a fixed summary; a free model costs nothing", async () => {
    const gateway = createScriptedGateway(new ScriptBook());

    const summary = await gateway
      .chatModel({ user: { kind: "compaction" }, settings: free })
      .invoke("summarise");

    expect(summary.text).toBe(UNSCRIPTED_SUMMARY);
    expect(summary.usage_metadata?.output_tokens).toBe(0);
  });
});

describe("AC12: setup errors name what is wrong", () => {
  it("real: [X] must be an MCP server of the workflow", async () => {
    await expect(TestEnvironment.of(DeskApplication, { real: [Writer] })).rejects.toThrow(
      "real: [Writer] — not an MCP server of this application",
    );
  });

  it("mcpOf(X) must be an MCP server of the workflow", async () => {
    const environment = await TestEnvironment.of(DeskApplication);

    class Other extends McpServerClient<Record<string, never>> {}

    expect(() => environment.mcpOf(Other)).toThrow(
      "mcpOf(Other): not an MCP server of this application",
    );
    await environment.close();
  });
});
