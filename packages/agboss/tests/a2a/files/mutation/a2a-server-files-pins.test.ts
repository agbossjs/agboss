/**
 * #1244: the listener's files as the options bound them — the fetch's timeout is the one given,
 * else the default.
 */
import { describe, expect, it, vi } from "vitest";
import type { A2AApp } from "../../../../src/a2a/a2a-caller.js";
import { DEFAULT_FILE_FETCH_TIMEOUT } from "../../../../src/a2a/files/a2a-file-options.js";
import { appFileSlotsOf } from "../../../../src/a2a/files/a2a-file-pool.js";
import { serverFilesOf } from "../../../../src/a2a/files/a2a-server-files.js";
import { seconds } from "../../../../src/units/index.js";

/** An app whose container resolves `store` as the file store. */
const appOf = (store: object): A2AApp => ({
  execute: vi.fn(),
  resume: vi.fn(),
  cancel: vi.fn(),
  resolve: vi.fn(() => store) as A2AApp["resolve"],
});
const app = appOf({});

describe("the listener's file fetch", () => {
  it("times out at the option given, else at the default", () => {
    expect(serverFilesOf(app, { fileFetchTimeout: seconds(3) }).timeout).toBe(3000);
    expect(serverFilesOf(app, {}).timeout).toBe(DEFAULT_FILE_FETCH_TIMEOUT);
  });

  it("with no limit option the slots are the application's, shared with a model's reads (#1312)", () => {
    const store = {};
    expect(serverFilesOf(appOf(store), {}).slots).toBe(appFileSlotsOf(store));
    expect(serverFilesOf(appOf(store), {}).slots).toBe(serverFilesOf(appOf(store), {}).slots);
    expect(serverFilesOf(appOf({}), {}).slots).not.toBe(appFileSlotsOf(store));
  });

  it("any limit option, alone, gives the listener slots of its own", () => {
    const store = {};
    for (const option of [
      "maxConcurrentFileFetches",
      "maxConcurrentFileFetchesPerTenant",
      "maxConcurrentFileFetchesPerOwner",
    ] as const) {
      expect(serverFilesOf(appOf(store), { [option]: 2 }).slots, option).not.toBe(
        appFileSlotsOf(store),
      );
    }
  });
});
