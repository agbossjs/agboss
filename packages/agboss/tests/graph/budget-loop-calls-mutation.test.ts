/**
 * #1356 (budget-loop shard) — what a call gives the model when its arguments are no input of its tool, how a tool's
 * output over the inline cap reaches it, and what a trusted call of the mesh is told it may still use.
 */
import { describe, expect, it, vi } from "vitest";
import { FileError } from "../../src/core/error-families/remote-errors.js";
import {
  FileRefusal,
  FileUnavailableReason,
  fileRefused,
  fileUnavailable,
} from "../../src/files/file-errors.js";
import { callOf, invalidInputOf, offloadedOutput } from "../../src/graph/agent-loop/call-output.js";
import { toolMeshCallOf } from "../../src/graph/agent-loop/mesh-call.js";
import { runTool } from "../../src/graph/agent-loop/run-tool.js";
import type { ToolTask } from "../../src/graph/agent-loop/state.js";

vi.mock("../../src/graph/agent-loop/run-tool.js", () => ({ runTool: vi.fn() }));

const failing = (...issues: { path: (string | number)[]; message: string }[]) => ({
  name: "write-tool",
  input: { safeParse: () => ({ success: false, error: { issues } }) },
});

describe("#1356: the error of arguments that are no input of the tool", () => {
  it("names every issue by its path, joined by dots, else `(root)`, and its reason, in order; no value", () => {
    const tool = failing(
      { path: ["to", 0, "name"], message: "Required" },
      { path: [], message: "Expected object" },
    );

    expect(invalidInputOf(tool as never, { secret: "x" })).toStrictEqual({
      kind: "error",
      message: "invalid input: to.0.name: Required; (root): Expected object",
    });
  });

  it("arguments that are valid after all are an error that names no issue", () => {
    const tool = { name: "t", input: { safeParse: () => ({ success: true, data: {} }) } };

    expect(invalidInputOf(tool as never, {})).toStrictEqual({
      kind: "error",
      message: "invalid input",
    });
  });
});

describe("#1356: what a call gives", () => {
  const task = (changes: object = {}) =>
    ({
      callId: "c1",
      tool: "write-tool",
      args: { a: 1 },
      runId: "run-1",
      prepared: { kind: "invalid", args: { a: 1 }, from: "model" },
      ...changes,
    }) as unknown as ToolTask;

  it("a call prepared as invalid runs no tool: the error of its arguments", async () => {
    const tool = failing({ path: ["a"], message: "Expected string" });

    const out = await callOf(tool as never, task(), {} as never, { a: 1 });

    expect(out).toStrictEqual({ kind: "error", message: "invalid input: a: Expected string" });
    expect(runTool).not.toHaveBeenCalled();
  });

  it("a question call prepared as invalid gives the problem its ask had, not the error of a tool's input", async () => {
    const tool = { ...failing({ path: ["a"], message: "Expected string" }), question: {} };

    const out = await callOf(
      tool as never,
      task({ invalidAsk: "invalid input: a: Expected string (ask)" }),
      {} as never,
      { a: 1 },
    );

    expect(out).toStrictEqual({
      kind: "error",
      message: "invalid input: a: Expected string (ask)",
    });
    expect(runTool).not.toHaveBeenCalled();
  });

  it("a call prepared as ready runs its tool with the arguments it is given", async () => {
    vi.mocked(runTool).mockResolvedValue({ kind: "ok", value: 7 });
    const tool = { name: "write-tool", input: { safeParse: () => ({ success: true }) } };
    const context = { signal: "s" };

    const out = await callOf(
      tool as never,
      task({ prepared: { kind: "ready", args: { a: 1 }, shown: {}, from: "model" } }),
      context as never,
      { a: 2 },
    );

    expect(out).toStrictEqual({ kind: "ok", value: 7 });
    expect(runTool).toHaveBeenCalledWith(tool, { a: 2 }, context);
  });
});

describe("#1356: a tool's output over the inline cap", () => {
  const ok = Promise.resolve({ kind: "ok", value: { f: 1 } } as const);
  const failingWith = (error: unknown) => ({
    inlineFiles: vi.fn(() => Promise.reject(error instanceof Error ? error : new Error("x"))),
  });
  const caught = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error: unknown) => error,
    );

  it("an output that is no success is as the tool gave it, and its files are not looked at", async () => {
    const deps = { inlineFiles: vi.fn() };
    const error = { kind: "error", message: "boom" } as const;

    expect(await offloadedOutput(deps as never, Promise.resolve(error))).toBe(error);
    expect(deps.inlineFiles).not.toHaveBeenCalled();
  });

  it("with no offload listed the output is as it is; with one it is offered the value", async () => {
    const deps = { inlineFiles: vi.fn(() => Promise.resolve()) };

    expect(await offloadedOutput({}, ok)).toEqual({ kind: "ok", value: { f: 1 } });
    expect(await offloadedOutput(deps as never, ok)).toEqual({ kind: "ok", value: { f: 1 } });
    expect(deps.inlineFiles).toHaveBeenCalledWith({ f: 1 });
  });

  it("a file over the inline cap is a fixed text with the refusal as its cause", async () => {
    const refusal = fileRefused({ refusal: FileRefusal.InlineTooLarge, sizeBytes: 99 });

    const out = await offloadedOutput(failingWith(refusal), ok);

    expect(out).toStrictEqual({
      kind: "error",
      message: "the output's inline files are over the cap and no file store is listed",
      cause: refusal,
    });
  });

  it("a file that does not match its digest is a fixed text with the error as its cause", async () => {
    const mismatch = fileUnavailable({ reason: FileUnavailableReason.DigestMismatch });

    const out = await offloadedOutput(failingWith(mismatch), ok);

    expect(out).toStrictEqual({
      kind: "error",
      message: "a file in the output does not match its digest or size",
      cause: mismatch,
    });
  });

  it.each([
    ["a refusal for another reason", fileRefused({ refusal: FileRefusal.TooLarge, sizeBytes: 9 })],
    [
      "a file that is unavailable for another reason",
      fileUnavailable({ reason: FileUnavailableReason.NotFound }),
    ],
    ["an error of the store", new Error("s3 says: secret-bucket")],
  ])("%s is the step's failure, never text the model reads", async (_why, error) => {
    const failure = await caught(offloadedOutput(failingWith(error), ok));

    expect(failure).toBe(error);
    expect(FileError.Refused).toBeDefined();
  });
});

describe("#1356: what a trusted call of the mesh is told it may still use", () => {
  const meshOf = (budgets: object) => {
    const { services } = toolMeshCallOf(
      { name: "t", timeout: 1000 },
      budgets as never,
      new Date(0),
    );
    const told = (read: (() => unknown) | undefined): unknown =>
      read === undefined ? "not offered" : read();
    return {
      remainingBudget: () => told(services.remainingBudget),
      remainingTokens: () => told(services.remainingTokens),
    };
  };

  it("the dollars and the tokens left, none for an end that is no number or a budget that tells nothing", () => {
    expect(meshOf({ remaining: () => 2.5, remainingTokens: () => 900 }).remainingBudget()).toBe(
      2.5,
    );
    expect(meshOf({ remaining: () => 2.5, remainingTokens: () => 900 }).remainingTokens()).toBe(
      900,
    );
    expect(
      meshOf({ remaining: () => Infinity, remainingTokens: () => Infinity }).remainingTokens(),
    ).toBeUndefined();
    expect(meshOf({ remaining: () => Infinity }).remainingBudget()).toBeUndefined();
    expect(meshOf({}).remainingBudget()).toBeUndefined();
    expect(meshOf({}).remainingTokens()).toBeUndefined();
  });
});
