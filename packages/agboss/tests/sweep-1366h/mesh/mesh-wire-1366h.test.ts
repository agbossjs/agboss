/**
 * #1366: what a mesh limit reads as off the wire: the loop and the hops refusal come back as their own error
 * class with their entry, chain (each hop with its execution) and maxMeshHops; a body with another code, a name
 * empty or over 200, a chain over 64 hops, or a maxMeshHops that is not an integer of at least 1 is no mesh limit.
 */
import { describe, expect, it } from "vitest";
import { HopsLimitExceededError, MeshLoopDetectedError } from "../../../src/index.js";
import { meshLimitErrorOf } from "../../../src/mesh/mesh-wire.js";

const entry = { application: "orders-application", start: "orders-workflow-start" };
const hop = (index: number) => ({ ...entry, executionId: `e-${String(index)}` });

const loop = (details: unknown) => ({ code: "limit.mesh-loop", error: "loop", details });
const hops = (details: unknown) => ({ code: "limit.hops", error: "hops", details });

describe("#1366: a mesh limit read off the wire", () => {
  it("the loop: its class, entry and chain with the executions", () => {
    const error = meshLimitErrorOf(loop({ entry, chain: [hop(1), hop(2)] }));

    expect(error).toBeInstanceOf(MeshLoopDetectedError);
    expect(error).toMatchObject({ code: "limit.mesh-loop", entry, callChain: [hop(1), hop(2)] });
  });

  it("the hops refusal: its class, entry, chain and maxMeshHops", () => {
    const error = meshLimitErrorOf(hops({ entry, chain: [hop(1), hop(2)], maxMeshHops: 2 }));

    expect(error).toBeInstanceOf(HopsLimitExceededError);
    expect(error).toMatchObject({
      code: "limit.hops",
      entry,
      callChain: [hop(1), hop(2)],
      maxMeshHops: 2,
      hops: 3,
    });
  });

  it("a name of one character and one of 128 are read, an empty one or one of 129 is no mesh limit", () => {
    const named = (name: string) => ({ application: name, start: name });
    const body = (name: string) =>
      hops({ entry: named(name), chain: [{ ...named(name), executionId: name }], maxMeshHops: 1 });

    expect(meshLimitErrorOf(body("a"))).toBeInstanceOf(HopsLimitExceededError);
    expect(meshLimitErrorOf(body("a".repeat(128)))).toBeInstanceOf(HopsLimitExceededError);
    expect(meshLimitErrorOf(body(""))).toBeUndefined();
    expect(meshLimitErrorOf(body("a".repeat(129)))).toBeUndefined();
    expect(
      meshLimitErrorOf(hops({ entry, chain: [{ ...entry, executionId: "" }], maxMeshHops: 1 })),
    ).toBeUndefined();
    expect(meshLimitErrorOf(hops({ entry, chain: [entry], maxMeshHops: 1 }))).toBeUndefined();
  });

  it("a chain of 64 hops is read, one of 65 is not (the loop and the hops alike)", () => {
    const chain = (length: number) => Array.from({ length }, (_, index) => hop(index));

    expect(meshLimitErrorOf(loop({ entry, chain: chain(64) }))).toBeInstanceOf(
      MeshLoopDetectedError,
    );
    expect(meshLimitErrorOf(loop({ entry, chain: chain(65) }))).toBeUndefined();
    expect(meshLimitErrorOf(hops({ entry, chain: chain(64), maxMeshHops: 8 }))).toBeInstanceOf(
      HopsLimitExceededError,
    );
    expect(meshLimitErrorOf(hops({ entry, chain: chain(65), maxMeshHops: 8 }))).toBeUndefined();
  });

  it("maxMeshHops is an integer of at least 1", () => {
    const withMax = (maxMeshHops: unknown) => hops({ entry, chain: [hop(1)], maxMeshHops });

    expect(meshLimitErrorOf(withMax(1))).toBeInstanceOf(HopsLimitExceededError);
    expect(meshLimitErrorOf(withMax(8))).toBeInstanceOf(HopsLimitExceededError);
    for (const bad of [0, -1, 1.5, "2", undefined])
      expect(meshLimitErrorOf(withMax(bad))).toBeUndefined();
  });

  it("any other code, or no body, is no mesh limit", () => {
    expect(
      meshLimitErrorOf({ code: "limit.budget", details: { entry, chain: [] } }),
    ).toBeUndefined();
    expect(meshLimitErrorOf(loop(undefined))).toBeUndefined();
    expect(meshLimitErrorOf(undefined)).toBeUndefined();
    expect(meshLimitErrorOf("limit.hops")).toBeUndefined();
  });
});
