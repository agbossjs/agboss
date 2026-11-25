/**
 * #1366: guardrails at run time — a model guardrail's call is paid under `guardrail:<name>`, asked as a guardrail with
 * the side's heading before the text, and a failed call is the cause of the closed failure; the refusal is the text,
 * else the class's own `refusal()` (nothing from a class without one); no assembled guardrails means none anywhere, and
 * the assembled ones by element and side; the observers hear each check with the sizes (not the bytes) of its files; a
 * block carries every decision made, the blocking one last.
 */
import { StepError } from "../../../src/core/error-families/step-errors.js";
import { GuardrailError } from "../../../src/core/error-families/limit-errors.js";
import { bareRecordOf, ComponentKind } from "../../../src/flow/runtime/records.js";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import { GuardrailSide } from "../../../src/components/policy-decorators.js";
import { carriedRecordsOf } from "../../../src/flow/runtime/carried-records.js";
import {
  checkGuardrail,
  checkGuardrails,
  guardrailRuntimeOf,
  runtimeGuardrailOf,
} from "../../../src/guardrails/runtime.js";
import {
  GUARDRAIL_ANSWER_TOOL,
  GUARDRAIL_QUESTION,
  GUARDRAIL_SYSTEM,
  guardrailInputHeading,
  guardrailOutputHeading,
} from "../../../src/prompts/guardrail.js";
import type { UsageRecord } from "../../../src/finops/usage.js";

vi.mock("../../../src/flow/observers/execution-event.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/flow/observers/execution-event.js")>()),
  reportNodeEvent: async (report: (base: object) => unknown) => {
    await report({ executionId: "e1" });
  },
}));

interface Seen {
  readonly specs: unknown[];
  readonly asked: BaseMessage[][];
}

function partsOf(
  answer: Record<string, unknown> | Error,
  resolve: (cls: unknown) => unknown = () => undefined,
) {
  const seen: Seen = { specs: [], asked: [] };
  const chat = {
    bindTools: () => ({
      invoke: (messages: BaseMessage[]) => {
        seen.asked.push(messages);
        if (answer instanceof Error) return Promise.reject(answer);
        return Promise.resolve(
          new AIMessage({
            content: "",
            tool_calls: [{ id: "c1", name: GUARDRAIL_ANSWER_TOOL, args: answer }],
            response_metadata: { usage: { cost: 0.25 } },
          }),
        );
      },
    }),
  };
  const parts = {
    resolve,
    modelOf: () => ({ kind: "llm" as const, model: "m" }),
    deciderDeps: {
      gateway: {
        chatModel: (spec: unknown) => {
          seen.specs.push(spec);
          return chat;
        },
        routeTo: () => Promise.reject(new Error("unused")),
      },
      chatDefaults: { temperature: 0 },
    },
  };
  return { parts: parts as never, seen };
}

const modelGuardrail = (overrides: object = {}) =>
  ({
    type: Object,
    name: "legal",
    kind: "model",
    model: "m",
    prompt: "is it legal advice?",
    threshold: 0.8,
    ...overrides,
  }) as never;

const textOf = (side: GuardrailSide) =>
  ({ side, component: { name: "agent" }, text: "hello" }) as never;
const YES = { [GUARDRAIL_QUESTION]: true };
const NO = { [GUARDRAIL_QUESTION]: false };

describe("#1366: how a model guardrail asks", () => {
  it("is paid under guardrail:<name>, asked as a guardrail by that name, with the system text", async () => {
    const { parts, seen } = partsOf(YES);
    const runtime = runtimeGuardrailOf(modelGuardrail(), parts);
    const spent: UsageRecord[] = [];

    await runtime.decide(textOf(GuardrailSide.Input), spent);

    expect(spent.map((each) => each.caller)).toEqual(["guardrail:legal"]);
    expect(seen.specs[0]).toMatchObject({ user: { kind: "guardrail", guardrail: "legal" } });
    expect(seen.asked[0]?.[0]?.content).toContain(GUARDRAIL_SYSTEM);
  });

  it("the text is read under the heading of its side", async () => {
    const { parts, seen } = partsOf(NO);
    const runtime = runtimeGuardrailOf(modelGuardrail(), parts);

    await runtime.decide(textOf(GuardrailSide.Input), []);
    await runtime.decide(textOf(GuardrailSide.Output), []);

    const read = (index: number) => JSON.stringify(seen.asked[index]?.[1]?.content);
    expect(read(0)).toContain(guardrailInputHeading("agent"));
    expect(read(0)).not.toContain(guardrailOutputHeading("agent"));
    expect(read(1)).toContain(guardrailOutputHeading("agent"));
    expect(read(1)).not.toContain(guardrailInputHeading("agent"));
  });

  it("a call that fails fails closed with the call's own error as the cause, and the spend so far", async () => {
    const down = new Error("provider down");
    const { parts } = partsOf(down);
    const runtime = runtimeGuardrailOf(modelGuardrail(), parts);

    const error = await runtime.decide(textOf(GuardrailSide.Input), []).catch((c: unknown) => c);

    expect(error).toBeInstanceOf(StepError.Guardrail);
    expect((error as StepError.Guardrail).cause).toBe(down);
  });
});

describe("#1366: the refusal of a guardrail", () => {
  const refusalOf = (instance: unknown, refusal?: string) => {
    const { parts } = partsOf(YES, () => instance);
    return runtimeGuardrailOf(modelGuardrail({ refusal }), parts).refusal({
      text: "",
      files: [],
      component: bareRecordOf("writer-agent", ComponentKind.Agent),
      side: GuardrailSide.Input,
    });
  };

  it("is its text when it has one", async () => {
    expect(await refusalOf(undefined, "no legal advice")).toBe("no legal advice");
  });

  it("is the class's own refusal() when it has none", async () => {
    expect(await refusalOf({ refusal: () => Promise.resolve("from the class") })).toBe(
      "from the class",
    );
    expect(await refusalOf({ refusal: () => "sync class text" })).toBe("sync class text");
  });

  it.each([
    ["no instance", undefined],
    ["a null instance", null],
    ["a text for an instance", "text"],
    ["an object without refusal", {}],
    ["a refusal that is no function", { refusal: "just text" }],
  ])("is none for %s: a block with no refusal fails closed (#1289)", async (_name, instance) => {
    expect(await refusalOf(instance)).toBeUndefined();
  });
});

describe("#1366: the runtime of a workflow's guardrails", () => {
  it("is empty without assembled guardrails: none anywhere", () => {
    const { parts } = partsOf(YES);

    const runtime = guardrailRuntimeOf(undefined, parts);

    expect(runtime.guardrails).toEqual([]);
    expect(runtime.inputOf("agent")).toEqual([]);
    expect(runtime.outputOf("agent")).toEqual([]);
  });

  it("gives each element's guardrails by side, and every one assembled", () => {
    const InputOne = (): void => undefined;
    const OutputOne = (): void => undefined;
    const { parts } = partsOf(YES);
    const first = modelGuardrail({ type: InputOne, name: "in", refusal: "r" });
    const second = modelGuardrail({ type: OutputOne, name: "out", refusal: "r" });
    const assembled = {
      guardrails: [first, second],
      byElement: new Map([["agent", { input: [first], output: [second] }]]),
    };

    const runtime = guardrailRuntimeOf(assembled, parts);

    expect(runtime.guardrails).toEqual([first, second]);
    expect(runtime.inputOf("agent").map((each) => each.guardrail.name)).toEqual(["in"]);
    expect(runtime.outputOf("agent").map((each) => each.guardrail.name)).toEqual(["out"]);
    expect(runtime.inputOf("another")).toEqual([]);
  });

  it("an element's guardrail that was not assembled is skipped, never made up", () => {
    const Known = (): void => undefined;
    const Unknown = (): void => undefined;
    const { parts } = partsOf(YES);
    const known = modelGuardrail({ type: Known, name: "known", refusal: "r" });
    const stray = modelGuardrail({ type: Unknown, name: "stray", refusal: "r" });
    const assembled = {
      guardrails: [known],
      byElement: new Map([["agent", { input: [known, stray], output: [stray] }]]),
    };

    const runtime = guardrailRuntimeOf(assembled, parts);

    expect(runtime.inputOf("agent").map((each) => each.guardrail.name)).toEqual(["known"]);
    expect(runtime.outputOf("agent")).toEqual([]);
  });
});

describe("#1366: what the observers hear of a check", () => {
  const observerOf = () => {
    const started: { input: unknown }[] = [];
    const ended: unknown[] = [];
    return {
      started,
      ended,
      observer: {
        onGuardrailStart: (event: { input: unknown }) => {
          started.push(event);
        },
        onGuardrailEnd: (event: unknown) => {
          ended.push(event);
        },
      },
    };
  };
  const file = (filename: string | undefined) => ({
    content: {
      mediaType: "text/plain",
      ...(filename === undefined ? {} : { filename }),
      bytes: new Uint8Array([1, 2, 3, 4, 5]),
      sha256: "abc",
    },
    pieces: [],
  });

  it("a text with files reports each file's type, name, size and hash — never its bytes", async () => {
    const { parts } = partsOf(NO);
    const runtime = runtimeGuardrailOf(modelGuardrail(), parts);
    const heard = observerOf();
    const checked = {
      side: GuardrailSide.Input,
      component: { name: "agent" },
      text: "hello",
      files: [file("a.txt"), file(undefined)],
    } as never;

    await checkGuardrail(runtime, checked, [], heard.observer as never);

    expect(heard.started[0]?.input).toStrictEqual({
      side: GuardrailSide.Input,
      component: { name: "agent" },
      text: "hello",
      files: [
        { mediaType: "text/plain", filename: "a.txt", sizeBytes: 5, sha256: "abc" },
        { mediaType: "text/plain", sizeBytes: 5, sha256: "abc" },
      ],
    });
    expect(heard.ended).toHaveLength(1);
  });

  it("a text without files reports none", async () => {
    const { parts } = partsOf(NO);
    const runtime = runtimeGuardrailOf(modelGuardrail(), parts);
    const heard = observerOf();

    await checkGuardrail(runtime, textOf(GuardrailSide.Output), [], heard.observer as never);

    expect(heard.started[0]?.input).toEqual({
      side: GuardrailSide.Output,
      component: { name: "agent" },
      text: "hello",
    });
  });
});

describe("#1366: a block carries what was decided", () => {
  it("the blocked check carries every decision made so far, the blocking one last, and the spend", async () => {
    const passing = runtimeGuardrailOf(
      modelGuardrail({ name: "first", refusal: "r1" }),
      partsOf(NO).parts,
    );
    const blocking = runtimeGuardrailOf(
      modelGuardrail({ name: "second", refusal: "r2" }),
      partsOf(YES).parts,
    );

    const result = await checkGuardrails([passing, blocking], textOf(GuardrailSide.Input));

    if (result.kind !== "blocked") throw new Error("expected a block");
    expect(result.error).toBeInstanceOf(GuardrailError.Blocked);
    expect(result.decisions.map((each) => each.isBlocked)).toEqual([false, true]);
    expect(carriedRecordsOf(result.error).guardrailDecisions).toEqual(result.decisions);
    expect(result.usage.map((each) => each.costUsd)).toEqual([0.25, 0.25]);
  });
});
