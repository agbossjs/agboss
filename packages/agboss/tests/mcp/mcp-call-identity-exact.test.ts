/**
 * #1356 (mesh-charge, once-mesh): the exact identity of an MCP call (`callId`, the ledger key of its cost). Each id is
 * worked out here from its parts, so a changed part, separator, position or argument order is a different id.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { callIdOf } from "../../src/components/mcp-call-identity.js";
import { McpError } from "../../src/core/error-families/remote-errors.js";
import { runInFrame } from "../../src/flow/context/frame.js";
import { testFrame } from "../helpers/frame.js";

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/** A step's frame: its idempotency key is the one every id is made of. */
const spec = testFrame();
const stepKey = (): string => spec.step.idempotencyKey;
const inStep = <T>(work: () => T): Promise<T> => runInFrame(spec, () => Promise.resolve(work()));

const keyed = (server: string, tool: string, key: string): string =>
  sha([stepKey(), server, tool, key, ""].join("\u0000"));
const keyless = (server: string, tool: string, position: number, argsText: string): string =>
  sha([stepKey(), server, tool, "", `${String(position)}:${sha(argsText)}`].join("\u0000"));

describe("#1356: the id of an MCP call", () => {
  it("with an explicit key is the hash of the step key, the server, the tool and the key, apart by NUL", async () => {
    const id = await inStep(() => callIdOf("kb", "ping", "second"));

    expect(id).toBe(keyed("kb", "ping", "second"));
    expect(id).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("an explicit key is the same id whatever the arguments and however many calls came before", async () => {
    const ids = await inStep(() => [
      callIdOf("kb", "ping", "k", { a: 1 }),
      callIdOf("kb", "ping", undefined),
      callIdOf("kb", "ping", "k", { b: 2 }),
    ]);

    expect(ids[0]).toBe(keyed("kb", "ping", "k"));
    expect(ids[2]).toBe(ids[0]);
  });

  it("a keyless call is told by its position (from 0, counted in the step) and its arguments", async () => {
    const ids = await inStep(() => [
      callIdOf("kb", "ping", undefined),
      callIdOf("kb", "ping", undefined),
      callIdOf("kb", "ping", undefined, { q: "x" }),
    ]);

    expect(ids).toEqual([
      keyless("kb", "ping", 0, "null"),
      keyless("kb", "ping", 1, "null"),
      keyless("kb", "ping", 2, '{"q":"x"}'),
    ]);
  });

  it("the position is counted per frame: another frame starts again at 0", async () => {
    const first = await inStep(() => callIdOf("kb", "ping", undefined));
    const other = await inStep(() => callIdOf("kb", "ping", undefined));

    expect(first).toBe(keyless("kb", "ping", 0, "null"));
    expect(other).toBe(first);
  });

  it("the arguments are read with their keys sorted, however deep, and arrays stay in order", async () => {
    const [sorted, shuffled, nested, array, scalar] = await inStep(() => [
      callIdOf("kb", "ping", undefined, { a: 1, b: 2, c: 3 }),
      callIdOf("kb", "ping", undefined, { c: 3, a: 1, b: 2 }),
      callIdOf("kb", "ping", undefined, { z: { y: 1, x: 2 }, a: [3, 1, 2] }),
      callIdOf("kb", "ping", undefined, [{ b: 1, a: 2 }, 5]),
      callIdOf("kb", "ping", undefined, "text"),
    ]);

    expect(sorted).toBe(keyless("kb", "ping", 0, '{"a":1,"b":2,"c":3}'));
    expect(shuffled).toBe(keyless("kb", "ping", 1, '{"a":1,"b":2,"c":3}'));
    expect(nested).toBe(keyless("kb", "ping", 2, '{"a":[3,1,2],"z":{"x":2,"y":1}}'));
    expect(array).toBe(keyless("kb", "ping", 3, '[{"a":2,"b":1},5]'));
    expect(scalar).toBe(keyless("kb", "ping", 4, '"text"'));
  });

  it("keys that sort apart by their code units come out in that order, whichever way they came in", async () => {
    const ids = await inStep(() => [
      callIdOf("kb", "ping", undefined, { b: 1, a: 1, B: 1, _: 1 }),
      callIdOf("kb", "ping", undefined, { _: 1, B: 1, a: 1, b: 1 }),
    ]);

    expect(ids[0]).toBe(keyless("kb", "ping", 0, '{"B":1,"_":1,"a":1,"b":1}'));
    expect(ids[1]).toBe(keyless("kb", "ping", 1, '{"B":1,"_":1,"a":1,"b":1}'));
  });

  it("arguments that cannot be written as JSON are a contract error, not an id", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(inStep(() => callIdOf("kb", "ping", undefined, circular))).rejects.toBeInstanceOf(
      McpError.Contract,
    );
    await expect(inStep(() => callIdOf("kb", "ping", undefined, 10n))).rejects.toBeInstanceOf(
      McpError.Contract,
    );
  });

  it("is nothing outside a step", () => {
    expect(callIdOf("kb", "ping", undefined)).toBeUndefined();
    expect(callIdOf("kb", "ping", "k")).toBeUndefined();
  });
});
