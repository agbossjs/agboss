/**
 * #1366: the mesh limit errors state their key, their limit and figures, and default to an empty path, no spend and no
 * records; a mesh limit is told from any other error.
 */
import { describe, expect, it } from "vitest";
import { LimitExceededError } from "../../../src/graph/limits.js";
import {
  HopsLimitExceededError,
  isMeshLimitError,
  MeshLoopDetectedError,
} from "../../../src/mesh/mesh-errors.js";

const entry = { application: "billing", start: "charge" };
const chain = [{ application: "shop", start: "buy", executionId: "e1" }];

describe("#1366: mesh limit errors", () => {
  it("a loop is keyed mesh.callChain, with an empty place when none is given", () => {
    const error = new MeshLoopDetectedError({ entry, chain });

    expect(error.key).toBe("mesh.callChain");
    expect(error.limit).toBe(1);
    expect(error.actual).toBe(2);
    expect(error.path).toEqual([]);
    expect(error.spentUsd).toBe(0);
    expect(error.usage).toEqual([]);
    expect(error.details).toMatchObject({ key: "mesh.callChain", entry, chain });
  });

  it("a hops limit with no place has an empty path, no spend and no records", () => {
    const error = new HopsLimitExceededError({ entry, chain, maxMeshHops: 1 });

    expect(error.key).toBe("maxMeshHops");
    expect(error).toMatchObject({ limit: 1, actual: 2, hops: 2, spentUsd: 0 });
    expect(error.path).toEqual([]);
    expect(error.usage).toEqual([]);
    expect(error.details).toMatchObject({ maxMeshHops: 1, hops: 2 });
  });

  it("isMeshLimitError is true for both mesh limits and false for any other error", () => {
    expect(isMeshLimitError(new MeshLoopDetectedError({ entry, chain }))).toBe(true);
    expect(isMeshLimitError(new HopsLimitExceededError({ entry, chain, maxMeshHops: 1 }))).toBe(
      true,
    );
    expect(
      isMeshLimitError(
        new LimitExceededError({ key: "k", limit: 1, actual: 2, path: [], spentUsd: 0 }),
      ),
    ).toBe(false);
    expect(isMeshLimitError(new Error("x"))).toBe(false);
    expect(isMeshLimitError(undefined)).toBe(false);
  });
});
