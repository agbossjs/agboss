import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  defineTool,
  InvalidToolNameError,
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

    expect(await tool.invoke({ text: "a" }, ctx())).toEqual({ kind: "error", message: "boom" });
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
    });
  });

  it("does not start work when the run is already aborted", async () => {
    const run = vi.fn<Run>(() => Promise.resolve({ length: 1 }));

    expect(
      await echo(run).invoke({ text: "a" }, ctx(abortedWith(new Error("run cancelled")))),
    ).toEqual({
      kind: "error",
      message: "run cancelled",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("reports a non-Error abort reason as text", async () => {
    expect(await echo().invoke({ text: "a" }, ctx(abortedWith("user left")))).toEqual({
      kind: "error",
      message: "user left",
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
