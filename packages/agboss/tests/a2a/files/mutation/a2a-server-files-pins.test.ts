/**
 * #1244: the listener's files as the skills' policies bound them — slots from the policy's own
 * `fetchPool`, else the application's, shared with a model's reads (#1312, #1316).
 */
import { describe, expect, it, vi } from "vitest";
import type { A2AApp } from "../../../../src/a2a/a2a-caller.js";
import { appFileSlotsOf } from "../../../../src/a2a/files/a2a-file-pool.js";
import { serverFilesOf } from "../../../../src/a2a/files/a2a-server-files.js";
import { DEFAULT_FILE_LIMITS } from "../../../../src/files/file-policy.js";

/** An app whose container resolves `store` as the file store. */
const appOf = (store: object): A2AApp => ({
  execute: vi.fn(),
  resume: vi.fn(),
  cancel: vi.fn(),
  resolve: vi.fn(() => store) as A2AApp["resolve"],
});

describe("the listener's file fetch", () => {
  it("a policy with no fetchPool: the application's slots, shared with a model's reads (#1312)", () => {
    const store = {};
    const { slotsOf } = serverFilesOf(appOf(store), {});

    expect(slotsOf(DEFAULT_FILE_LIMITS)).toBe(appFileSlotsOf(store));
    expect(serverFilesOf(appOf(store), {}).slotsOf(DEFAULT_FILE_LIMITS)).toBe(
      slotsOf(DEFAULT_FILE_LIMITS),
    );
    expect(serverFilesOf(appOf({}), {}).slotsOf(DEFAULT_FILE_LIMITS)).not.toBe(
      appFileSlotsOf(store),
    );
  });

  it("a policy with its own fetchPool: slots of its own, the same for every fetch of that pool", () => {
    const store = {};
    const pool = { maxConcurrent: 2 };
    const { slotsOf } = serverFilesOf(appOf(store), {});
    const limits = { ...DEFAULT_FILE_LIMITS, fetchPool: pool };

    expect(slotsOf(limits)).not.toBe(appFileSlotsOf(store));
    expect(slotsOf(limits)).toBe(slotsOf(limits));
    // a pool is its fields, not its object (#1316b review): an equal pool is the same pool
    expect(slotsOf({ ...DEFAULT_FILE_LIMITS, fetchPool: { maxConcurrent: 2 } })).toBe(
      slotsOf(limits),
    );
    expect(slotsOf({ ...DEFAULT_FILE_LIMITS, fetchPool: { maxConcurrent: 3 } })).not.toBe(
      slotsOf(limits),
    );
  });
});
