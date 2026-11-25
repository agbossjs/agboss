/**
 * `reset()` of every script the testing API hands out (#1328a): it forgets what was scripted and
 * what was recorded, so the next call runs the real thing, or — where nothing real exists — reports
 * that nothing is scripted. Each test fails if a line of its `reset` body is removed.
 */
import { describe, expect, it } from "vitest";
import { ActionCalls } from "../../src/testing/action-script.js";
import { ComponentScript } from "../../src/testing/component-script.js";
import { LiveCallBlockedError, TestFailure } from "../../src/testing/errors.js";
import { McpStubs } from "../../src/testing/mcp-stubs.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { ToolFailure, ToolScripts } from "../../src/testing/tool-script.js";
import type { ModelRequest } from "../../src/testing/model-script.js";
import type { ScriptedTurn } from "../../src/testing/turns.js";
import { OrderBook, OrderStatus } from "./fixtures/desk.workflow.js";

/** Stands for the DTO class an action returned. */
class ShippedDto {
  readonly trackingNumber = "t7";
}

const reply = (text: string): ScriptedTurn => ({ kind: "reply", text, details: {} });
const request = {} as ModelRequest;

describe("ModelScript.reset", () => {
  it("forgets turns, whens and every recorded call; the next call is blocked", () => {
    const script = new ComponentScript("Writer", true);
    script.thenReturn(reply("a"), reply("b"));
    script.when({ topic: "x" }).thenReturn(reply("w"));
    expect(script.next(request, { topic: "x" }).turn).toMatchObject({ text: "w" });
    expect(script.next(request, { topic: "y" }).turn).toMatchObject({ text: "a" });
    script.requests.push(request);
    script.toolCalls.push("lookup");
    expect(script.inputs).toHaveLength(2);
    expect(script.returned).toHaveLength(2);

    expect(script.reset()).toBe(script);

    expect(script.isScripted).toBe(false);
    expect(script.requests).toEqual([]);
    expect(script.toolCalls).toEqual([]);
    expect(script.inputs).toEqual([]);
    expect(script.returned).toEqual([]);
    expect(script.leftovers()).toEqual([]);
    expect(() => script.next(request, { topic: "x" })).toThrow(LiveCallBlockedError);
  });

  it("forgets a respondWith handler", () => {
    const script = new ComponentScript("Writer", false);
    script.respondWith(() => reply("handled"));
    expect(script.next(request).turn).toMatchObject({ text: "handled" });

    script.reset();

    expect(script.isScripted).toBe(false);
    expect(() => script.next(request)).toThrow(LiveCallBlockedError);
  });

  it("a turn queue of a script is scripted afresh after the reset", () => {
    const script = new ComponentScript("Writer", false);
    script.thenReturn(reply("a"));
    script.next();
    script.reset();
    script.thenReturn(reply("b"));

    expect(script.next().turn).toMatchObject({ text: "b" });
    expect(() => script.next()).toThrow(TestFailure);
  });
});

describe("ToolScript.reset", () => {
  const instanceOf = () => new OrderStatus(new OrderBook());
  const run = (tool: OrderStatus) => Promise.resolve(tool.execute({ orderId: "7" }));

  it("forgets the scripted calls: the next call runs the real tool", async () => {
    const scripts = new ToolScripts(() => undefined);
    const script = scripts.scriptOf(OrderStatus).thenReturn({ status: "scripted" });
    const tool = instanceOf();
    scripts.patch(tool);

    script.reset();

    await expect(run(tool)).resolves.toEqual({ status: "order 7 shipped" });
  });

  it("forgets the position: a call scripted after the reset is the next one served", async () => {
    const scripts = new ToolScripts(() => undefined);
    const script = scripts.scriptOf(OrderStatus).thenReturn({ status: "first" });
    const tool = instanceOf();
    scripts.patch(tool);
    await expect(run(tool)).resolves.toEqual({ status: "first" });

    script.reset().thenReturn({ status: "second" });

    await expect(run(tool)).resolves.toEqual({ status: "second" });
    await expect(run(tool)).resolves.toEqual({ status: "order 7 shipped" });
  });

  it("forgets a scripted failure", async () => {
    const scripts = new ToolScripts(() => undefined);
    const script = scripts.scriptOf(OrderStatus).thenFail(ToolFailure.Timeout);
    const tool = instanceOf();
    scripts.patch(tool);

    script.reset();

    await expect(run(tool)).resolves.toEqual({ status: "order 7 shipped" });
  });
});

describe("ActionScript.reset", () => {
  it("forgets the recorded inputs and returned values", () => {
    const calls = new ActionCalls("ShipOrderAction");
    calls.inputs.push({ order: { orderId: "7" } });
    calls.returned.push({ dto: ShippedDto, value: { trackingNumber: "t7" } });

    expect(calls.reset()).toBe(calls);

    expect(calls.inputs).toEqual([]);
    expect(calls.returned).toEqual([]);
  });
});

describe("McpStub.reset", () => {
  it("forgets the handlers and the calls: the next call is a blocked live one", async () => {
    const stubs = new McpStubs(new ScriptBook());
    const stub = stubs.stubOf("notes");
    stub.thenReturn({ write_file: () => Promise.resolve({ ok: true }) });
    const caller = stubs.callerOf("notes", "NotesServer");
    const signal = new AbortController().signal;
    await caller("write_file", { title: "n" }, signal);
    expect(stub.calls).toEqual([{ tool: "write_file", args: { title: "n" } }]);

    expect(stub.reset()).toBe(stub);

    expect(stub.calls).toEqual([]);
    await expect(caller("write_file", { title: "n" }, signal)).rejects.toBeInstanceOf(
      LiveCallBlockedError,
    );
  });
});
