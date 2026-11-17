/**
 * #1244: the listener's files as the options bound them — the fetch's timeout is the one given,
 * else the default.
 */
import { describe, expect, it, vi } from "vitest";
import type { A2AApp } from "../../../../src/a2a/a2a-caller.js";
import { DEFAULT_FILE_FETCH_TIMEOUT } from "../../../../src/a2a/files/a2a-file-options.js";
import { serverFilesOf } from "../../../../src/a2a/files/a2a-server-files.js";
import { seconds } from "../../../../src/units/index.js";

const app: A2AApp = {
  execute: vi.fn(),
  resume: vi.fn(),
  cancel: vi.fn(),
  resolve: vi.fn(),
};

describe("the listener's file fetch", () => {
  it("times out at the option given, else at the default", () => {
    expect(serverFilesOf(app, { fileFetchTimeout: seconds(3) }).timeout).toBe(3000);
    expect(serverFilesOf(app, {}).timeout).toBe(DEFAULT_FILE_FETCH_TIMEOUT);
  });
});
