/**
 * #1366: the limits a skill puts on the files of a message — their number, each one's size and their total size are
 * allowed up to and including the limit and refused above it.
 */
import { describe, expect, it } from "vitest";
import { filesOfMessage } from "../../../src/a2a/server/a2a-message-files.js";

const skill = (limits: { maxFiles: number; maxFileSize: number; maxTotalFileSize: number }) =>
  ({
    inputFiles: ["x"],
    fileLimits: { allowedMediaTypes: ["text/plain"], ...limits },
  }) as never;

const file = (size: number) => ({
  content: { $case: "raw", value: new Uint8Array(size) },
  mediaType: "text/plain",
  filename: "",
  metadata: undefined,
});

const messageOf = (...sizes: number[]) => ({ parts: sizes.map(file) }) as never;

const LIMITS = { maxFiles: 2, maxFileSize: 10, maxTotalFileSize: 15 };

describe("#1366: the limits on a message's files", () => {
  it("a message at every limit is taken", () => {
    expect(filesOfMessage(messageOf(10, 5), skill(LIMITS))).toHaveLength(2);
  });

  it("one file more than maxFiles is refused", () => {
    expect(() => filesOfMessage(messageOf(1, 1, 1), skill(LIMITS))).toThrow(/more files/u);
  });

  it("a file one byte over maxFileSize is refused", () => {
    expect(() => filesOfMessage(messageOf(11), skill(LIMITS))).toThrow(/file is larger/u);
  });

  it("files one byte over maxTotalFileSize together are refused, each within its own limit", () => {
    expect(() => filesOfMessage(messageOf(8, 8), skill(LIMITS))).toThrow(/files are larger/u);
  });
});
