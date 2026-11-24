/**
 * #1295c — a tool call is checked before anyone is asked about it: its input validated, its
 * arguments searched by the PII policies, the tool interceptors' `before` hooks run — all of it
 * before the approval pause and before the tool starts. A call that does not pass never pauses and
 * never runs; the approver sees the masked arguments; a rewrite of a hook is what is approved and
 * run; a resume and a restart at the approval reuse what was decided.
 */
import { MemorySaver } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { ToolCallDecision } from "../../../src/tool-interceptors/decision.js";
import type {
  RuntimeToolInterceptor,
  ToolInterceptorChains,
} from "../../../src/tool-interceptors/runtime.js";
import { PiiKind } from "../../../src/pii/kinds.js";
import { PiiPolicySet } from "../../../src/pii/policy-set.js";
import { runtimePolicyOf } from "../../../src/pii/runtime-policy.js";
import type { PiiPolicyMeta } from "../../../src/pii/pii-policy.decorator.js";
import type { PiiRule } from "../../../src/pii/pii-policy.decorator.js";
import {
  callTools,
  decision,
  harness,
  replyWith,
  runLoop,
  startInput,
  stateOf,
  toolMessagesOf,
  write,
} from "./fixtures.js";

const policySet = (...rules: PiiRule[]): PiiPolicySet =>
  new PiiPolicySet(
    [
      runtimePolicyOf({
        meta: {
          name: "contact-pii-policy",
          description: "d",
          rules,
          deps: [],
        } as never,
        instance: {},
        key: "k",
      }),
    ],
    "field-key",
  );

type BeforeHook = (call: { input: Record<string, unknown> }) => unknown;

/** One interceptor with a catch-all `beforeAnyTool`; `seen` notes each call it was given. */
function interceptors(seen: Record<string, unknown>[], hook: BeforeHook): ToolInterceptorChains {
  const chain: RuntimeToolInterceptor = {
    name: "desk-tool-interceptor",
    instance: {
      beforeAnyTool: (call) => {
        const given = call as { input: Record<string, unknown> };
        seen.push(given.input);
        return hook(given);
      },
    },
    toolType: undefined,
    beforeMethod: undefined,
    afterMethod: undefined,
  };
  return (tool) => (tool === "write_file" ? [chain] : []);
}

const allow = (): unknown => ToolCallDecision.allow();
const EMAIL = "alice@example.com";

describe("#1295c: the order of the checks", () => {
  it("the before hook has run when the approval asks, the tool has not; the hook is not run again after the answer", async () => {
    const seen: Record<string, unknown>[] = [];
    const h = harness({
      moves: [callTools(write("w1", "a.ts", "x")), replyWith("done")],
      interceptors: interceptors(seen, allow),
    });

    const paused = await runLoop(h.graph, startInput(), "t");

    expect(paused).toMatchObject({ kind: "paused", pending: { callId: "w1" } });
    expect(seen).toEqual([{ path: "a.ts", content: "x" }]);
    expect(h.effects).toEqual([]);

    await runLoop(h.graph, decision({ approved: true }), "t");

    expect(seen).toHaveLength(1);
    expect(h.effects).toEqual(["write a.ts=x"]);
  });

  it("an input that is no input of the tool never reaches the hooks or the approver: the model reads the tool's error", async () => {
    const seen: Record<string, unknown>[] = [];
    const h = harness({
      moves: [callTools({ id: "w1", name: "write_file", args: { path: 1 } }), replyWith("done")],
      interceptors: interceptors(seen, allow),
    });

    const end = await runLoop(h.graph, startInput(), "t");

    expect(end).toEqual({ kind: "answered", reply: "done" });
    expect(seen).toEqual([]);
    expect(h.effects).toEqual([]);
    const content = toolMessagesOf(h.model.sent.at(-1))[0]?.[1];
    expect(content).toContain("invalid input");
  });
});

describe("#1295c: a call that does not pass is never asked about and never runs", () => {
  it("a PII block rule in the arguments: no pause, no hook, no run; the model reads the refusal", async () => {
    const seen: Record<string, unknown>[] = [];
    const h = harness({
      moves: [callTools(write("w1", "a.ts", `mail ${EMAIL}`)), replyWith("done")],
      pii: policySet(PiiKind.Email.block("no emails")),
      interceptors: interceptors(seen, allow),
    });

    const end = await runLoop(h.graph, startInput(), "t");

    expect(end).toEqual({ kind: "answered", reply: "done" });
    expect(seen).toEqual([]);
    expect(h.effects).toEqual([]);
    const content = toolMessagesOf(h.model.sent.at(-1))[0]?.[1];
    expect(content).toContain("refused");
  });

  it("a before hook that blocks: no pause, no run; the step fails", async () => {
    const h = harness({
      moves: [callTools(write("w1", "a.ts")), replyWith("done")],
      interceptors: interceptors([], () => ToolCallDecision.block("not today")),
    });

    await expect(runLoop(h.graph, startInput(), "t")).rejects.toThrow(/not today/);

    expect(h.effects).toEqual([]);
    const snapshot = await h.graph.getState({
      configurable: { thread_id: "t" },
    });
    expect(snapshot.tasks.flatMap((task) => task.interrupts)).toEqual([]);
  });

  it("a before hook that replies: no pause, no run; the model reads the reply", async () => {
    const h = harness({
      moves: [callTools(write("w1", "a.ts")), replyWith("done")],
      interceptors: interceptors([], () => ToolCallDecision.reply("cached answer")),
    });

    const end = await runLoop(h.graph, startInput(), "t");

    expect(end).toEqual({ kind: "answered", reply: "done" });
    expect(h.effects).toEqual([]);
    expect(toolMessagesOf(h.model.sent.at(-1))).toEqual([["w1", "cached answer"]]);
  });

  it("a before hook that throws: no pause, no run", async () => {
    const h = harness({
      moves: [callTools(write("w1", "a.ts")), replyWith("done")],
      interceptors: interceptors([], () => {
        throw new Error("hook broke");
      }),
    });

    await expect(runLoop(h.graph, startInput(), "t")).rejects.toThrow();

    expect(h.effects).toEqual([]);
  });
});

describe("#1295c: what the approver sees and what runs", () => {
  it("the approver sees the arguments masked, the tool gets the real ones", async () => {
    const h = harness({
      moves: [callTools(write("w1", "a.ts", `mail ${EMAIL}`)), replyWith("done")],
      pii: policySet(PiiKind.Email.tokenize()),
    });

    const paused = await runLoop(h.graph, startInput(), "t");

    const shown = JSON.stringify(paused);
    expect(shown).not.toContain(EMAIL);
    expect(shown).toMatch(/<email:[0-9a-f]+>/);

    await runLoop(h.graph, decision({ approved: true }), "t");

    expect(h.effects).toEqual([`write a.ts=mail ${EMAIL}`]);
  });

  it("an allow({ input }) rewrite is what is approved and what runs", async () => {
    const h = harness({
      moves: [callTools(write("w1", "a.ts", "original")), replyWith("done")],
      interceptors: interceptors([], () =>
        ToolCallDecision.allow({ input: { path: "a.ts", content: "rewritten" } }),
      ),
    });

    const paused = await runLoop(h.graph, startInput(), "t");

    expect(JSON.stringify(paused)).toContain("rewritten");
    expect(JSON.stringify(paused)).not.toContain("original");

    await runLoop(h.graph, decision({ approved: true }), "t");

    expect(h.effects).toEqual(["write a.ts=rewritten"]);
  });

  it("a rewrite that is no input of the tool stops the call before its approval", async () => {
    const h = harness({
      moves: [callTools(write("w1", "a.ts")), replyWith("done")],
      interceptors: interceptors([], () => ToolCallDecision.allow({ input: { path: 7 } as never })),
    });

    await expect(runLoop(h.graph, startInput(), "t")).rejects.toThrow();

    expect(h.effects).toEqual([]);
  });

  it("a rewrite that brings in a blocked value is refused before its approval", async () => {
    const h = harness({
      moves: [callTools(write("w1", "a.ts")), replyWith("done")],
      pii: policySet(PiiKind.Email.block("no emails")),
      interceptors: interceptors([], () =>
        ToolCallDecision.allow({ input: { path: "a.ts", content: EMAIL } }),
      ),
    });

    const end = await runLoop(h.graph, startInput(), "t");

    expect(end).toEqual({ kind: "answered", reply: "done" });
    expect(h.effects).toEqual([]);
  });
});

describe("#1295c: the decisions survive a pause and a restart", () => {
  it("a restart at the approval reuses what was decided: no hook is run, nothing is masked again", async () => {
    const seen: Record<string, unknown>[] = [];
    const saver = new MemorySaver();
    const options = {
      moves: [callTools(write("w1", "a.ts", `mail ${EMAIL}`)), replyWith("done")],
      pii: policySet(PiiKind.Email.tokenize()),
      interceptors: interceptors(seen, allow),
    };
    const first = harness(options, saver);
    const paused = await runLoop(first.graph, startInput(), "t");
    const prepared = (await stateOf(first.graph, "t")).prepared;

    // another process: a new graph over the same checkpoints
    const second = harness(options, saver);
    const end = await runLoop(second.graph, decision({ approved: true }), "t");

    expect(end).toEqual({ kind: "answered", reply: "done" });
    expect(seen).toHaveLength(1);
    expect((await stateOf(second.graph, "t")).prepared).toEqual(prepared);
    expect(second.effects).toEqual([`write a.ts=mail ${EMAIL}`]);
    expect(JSON.stringify(paused)).not.toContain(EMAIL);
  });

  it("arguments an approver changed are arguments nobody checked: the PII rules read them once more, and a blocked value never runs", async () => {
    const seen: Record<string, unknown>[] = [];
    const h = harness({
      moves: [callTools(write("w1", "a.ts", "fine")), replyWith("done")],
      pii: policySet(PiiKind.Email.block("no emails")),
      interceptors: interceptors(seen, allow),
    });
    await runLoop(h.graph, startInput(), "t");

    const end = await runLoop(
      h.graph,
      decision({ approved: true, overrideArguments: { path: "a.ts", content: EMAIL } }),
      "t",
    );

    expect(end).toEqual({ kind: "answered", reply: "done" });
    expect(seen).toEqual([{ path: "a.ts", content: "fine" }]);
    expect(h.effects).toEqual([]);
  });

  it("arguments an approver changed within the rules reach the hooks once more and run, once, as changed", async () => {
    const seen: Record<string, unknown>[] = [];
    const h = harness({
      moves: [callTools(write("w1", "a.ts", "fine")), replyWith("done")],
      interceptors: interceptors(seen, allow),
    });
    await runLoop(h.graph, startInput(), "t");

    await runLoop(
      h.graph,
      decision({ approved: true, overrideArguments: { path: "b.ts", content: "changed" } }),
      "t",
    );

    expect(seen).toEqual([
      { path: "a.ts", content: "fine" },
      { path: "b.ts", content: "changed" },
    ]);
    expect(h.effects).toEqual(["write b.ts=changed"]);
  });
});
