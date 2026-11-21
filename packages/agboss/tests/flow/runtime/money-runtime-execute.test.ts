/**
 * #1366 (money-runtime shard) — how a run that stopped is read and recorded, each rule on its own: a run stopped by its
 * signal reads as cancelled whatever error the abort surfaced as — unless the instance handed it over (a stop is no
 * failure) —, and a run that failed writes its failed record (after the root's undo, when it has one), except a run
 * handed over, which writes nothing: another instance owns its record.
 */
import { describe, expect, it, vi } from "vitest";
import { ApplicationStoppingError, ExecutionCancelledError } from "../../../src/core/errors.js";
import { outcomeError, recordFailure } from "../../../src/run/execute.js";

const stopping = () => new ApplicationStoppingError({ message: "stopping" });

describe("#1366: the error a stopped run ends with", () => {
  it("a run whose signal did not fire ends with the error it had, and so does one with no signal", () => {
    const error = new Error("boom");

    expect(outcomeError(error, new AbortController().signal)).toBe(error);
    expect(outcomeError(error, undefined)).toBe(error);
  });

  it("a run whose signal fired ends cancelled, whatever error the abort surfaced as", () => {
    const controller = new AbortController();
    controller.abort();

    const ended = outcomeError(new Error("AbortError"), controller.signal);

    expect(ended).toBeInstanceOf(ExecutionCancelledError);
    expect(ended).toMatchObject({ message: "the run was cancelled" });
  });

  it("a cancel that is already the error stays as it is", () => {
    const controller = new AbortController();
    controller.abort();
    const cancelled = new ExecutionCancelledError({ message: "stopped by the user" });

    expect(outcomeError(cancelled, controller.signal)).toBe(cancelled);
  });

  it("a run handed over (the application is stopping) ends with that, not as cancelled", () => {
    const controller = new AbortController();
    const reason = stopping();
    controller.abort(reason);

    expect(outcomeError(new Error("AbortError"), controller.signal)).toBe(reason);
  });

  it("an error that is a hand-over itself is what the run ends with", () => {
    const handedOver = stopping();

    expect(outcomeError(handedOver, undefined)).toBe(handedOver);
  });
});

describe("#1366: the record of a run that failed", () => {
  it("a failure is written as it is, and is what the run throws", async () => {
    const write = vi.fn(() => Promise.resolve());
    const error = new Error("boom");

    const ended = await recordFailure(error, write);

    expect(ended).toBe(error);
    expect(write).toHaveBeenCalledExactlyOnceWith(error);
  });

  it("a tree's pass undoes the root first: the record gets the end of the undo", async () => {
    const write = vi.fn(() => Promise.resolve());
    const order: string[] = [];
    const undone = new Error("undo failed");
    const unwind = vi.fn((error: unknown) => {
      order.push(`unwind ${(error as Error).message}`);
      return Promise.resolve(undone);
    });
    write.mockImplementation(() => {
      order.push("write");
      return Promise.resolve();
    });

    const ended = await recordFailure(new Error("boom"), write, unwind);

    expect(ended).toBe(undone);
    expect(write).toHaveBeenCalledExactlyOnceWith(undone);
    expect(order).toEqual(["unwind boom", "write"]);
  });

  it("a run handed over writes nothing and undoes nothing: the record stays `running` for the instance that owns it", async () => {
    const write = vi.fn(() => Promise.resolve());
    const unwind = vi.fn(() => Promise.resolve(new Error("x")));
    const handedOver = stopping();

    const ended = await recordFailure(handedOver, write, unwind);

    expect(ended).toBe(handedOver);
    expect(write).not.toHaveBeenCalled();
    expect(unwind).not.toHaveBeenCalled();
  });
});
