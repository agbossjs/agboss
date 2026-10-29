import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ExecutionFencedError, ExecutionLeaseLostError } from "../../src/index.js";
import {
  defineTool,
  InvalidToolNameError,
  ToolTimeoutError,
  type ToolInvocationContext,
} from "../../src/tools/index.js";
import { seconds } from "../../src/units/index.js";

const ctx = (signal: AbortSignal = new AbortController().signal): ToolInvocationContext => ({
  signal,
  reportCost: vi.fn(),
});

type Run = (input: { text: string }) => Promise<{ length: number }>;

const echo = (run: Run = (input) => Promise.resolve({ length: input.text.length })) =>
  defineTool({
    name: "echo_length",
    description: "Length of a text",
    input: z.object({ text: z.string().min(1) }),
    output: z.object({ length: z.number().int() }),
    timeout: seconds(0.02),
    run,
  });

const abortedWith = (reason: unknown): AbortSignal => {
  const controller = new AbortController();
  controller.abort(reason);
  return controller.signal;
};

describe("defineTool", () => {
  it("returns the validated output", async () => {
    expect(await echo().invoke({ text: "abc" }, ctx())).toEqual({
      kind: "ok",
      value: { length: 3 },
    });
  });

  it("rejects invalid input before run", async () => {
    const run = vi.fn<Run>(() => Promise.resolve({ length: 0 }));

    expect(await echo(run).invoke({ text: "" }, ctx())).toMatchObject({
      kind: "error",
      message: expect.stringContaining("invalid input: text") as unknown,
    });
    expect(await echo(run).invoke("not an object", ctx())).toMatchObject({
      message: expect.stringContaining("(root)") as unknown,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("turns a thrown error into an error result", async () => {
    const tool = echo(() => Promise.reject(new Error("boom")));

    expect(await tool.invoke({ text: "a" }, ctx())).toEqual({
      kind: "error",
      message: "boom",
      cause: new Error("boom"), // what it threw: the trajectory's error (#395)
    });
  });

  it("rejects output that breaks the declared schema", async () => {
    const tool = echo(() => Promise.resolve({ length: 1.5 }));

    expect(await tool.invoke({ text: "a" }, ctx())).toMatchObject({
      kind: "error",
      message: expect.stringContaining("invalid output: length") as unknown,
    });
  });

  it("times out a tool that never answers", async () => {
    const tool = echo(() => new Promise<{ length: number }>(() => undefined));

    expect(await tool.invoke({ text: "a" }, ctx())).toEqual({
      kind: "error",
      message: "timed out after 0.02 s",
      cause: expect.any(ToolTimeoutError) as unknown,
    });
  });

  it("does not start work when the run is already aborted", async () => {
    const run = vi.fn<Run>(() => Promise.resolve({ length: 1 }));

    expect(
      await echo(run).invoke({ text: "a" }, ctx(abortedWith(new Error("run cancelled")))),
    ).toEqual({
      kind: "error",
      message: "run cancelled",
      cause: new Error("run cancelled"),
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("reports a non-Error abort reason as text", async () => {
    expect(await echo().invoke({ text: "a" }, ctx(abortedWith("user left")))).toEqual({
      kind: "error",
      message: "user left",
      cause: "user left",
    });
  });

  it("passes a signal to run and defaults effect and timeout", async () => {
    const tool = defineTool({
      name: "probe",
      description: "d",
      input: z.object({}),
      output: z.boolean(),
      run: (_input, context) => Promise.resolve(context.signal instanceof AbortSignal),
    });

    expect(await tool.invoke({}, ctx())).toEqual({ kind: "ok", value: true });
    expect(tool.timeout).toBe(seconds(30));
  });

  it("rejects names providers cannot accept", () => {
    expect(() =>
      defineTool({
        name: "github.search",
        description: "d",
        input: z.object({}),
        output: z.string(),
        run: () => Promise.resolve(""),
      }),
    ).toThrow(InvalidToolNameError);
  });
});

describe("defineTool: what rises instead of an error result (#471)", () => {
  it("a fenced write rises as the ExecutionFencedError, wrapped or not", async () => {
    const fenced = new ExecutionFencedError({
      scopeKey: "acme:root-1",
      token: 1,
      observedToken: 2,
    });

    for (const thrown of [fenced, new Error("the ledger refused", { cause: fenced })])
      await expect(echo(() => Promise.reject(thrown)).invoke({ text: "a" }, ctx())).rejects.toBe(
        fenced,
      );
  });

  it("a run failing after its lease was lost rises as the lost lease, not as the model's error", async () => {
    const lost = new ExecutionLeaseLostError("root-1");
    const controller = new AbortController();
    const tool = echo(() => {
      controller.abort(lost);
      return Promise.reject(new Error("the connection was closed"));
    });

    await expect(tool.invoke({ text: "a" }, ctx(controller.signal))).rejects.toBe(lost);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "boom"],
    ["a number", 42],
  ])("a run rejecting with %s is an error result, never a TypeError", async (_case, thrown) => {
    const tool = echo(vi.fn<Run>().mockRejectedValue(thrown));

    expect(await tool.invoke({ text: "a" }, ctx())).toMatchObject({ kind: "error" });
  });
});
