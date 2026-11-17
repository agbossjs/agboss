/**
 * #1269 (files-pii mutation shard): whether the optional peer dependency `sharp` resolves.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ isMissing: false }));

vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  return {
    createRequire: (...args: Parameters<typeof actual.createRequire>) => {
      const real = actual.createRequire(...args);
      const resolveReal = real.resolve.bind(real);
      const resolve = (id: string): string => {
        if (state.isMissing) throw new Error(`Cannot find module '${id}'`);
        return resolveReal(id);
      };
      return Object.assign(real, { resolve });
    },
  };
});

import { isSharpResolvable } from "../../src/files/sharp-check.js";

describe("isSharpResolvable", () => {
  afterEach(() => {
    state.isMissing = false;
  });

  it("is true where sharp is installed", () => {
    expect(isSharpResolvable()).toBe(true);
  });

  it("is false where sharp does not resolve", () => {
    state.isMissing = true;

    expect(isSharpResolvable()).toBe(false);
  });
});
