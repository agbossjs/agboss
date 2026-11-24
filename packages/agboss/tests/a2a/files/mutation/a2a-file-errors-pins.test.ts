/**
 * #1244: the two file errors, pinned exactly: message, code, details (a key only when its value is
 * given), cause and the fields.
 */
import { FileError } from "../../../../src/core/error-families/remote-errors.js";
import { fileRefused, fileUnavailable } from "../../../../src/files/file-errors.js";
import { describe, expect, it } from "vitest";
import { FileRefusal, FileUnavailableReason } from "../../../../src/files/file-errors.js";

describe("FileError.Refused", () => {
  it("the refusal alone: its message, code and details, no media type or size", () => {
    const error = fileRefused({ refusal: FileRefusal.OutsideExecution });

    expect(error.message).toBe("the file was refused: outside-execution");
    expect(error.code).toBe("files.refused");
    expect(FileError.Refused.code).toBe("files.refused");
    expect(error.name).toBe("FileError.Refused");
    expect(error.refusal).toBe("outside-execution");
    expect(error.mediaType).toBeUndefined();
    expect(error.sizeBytes).toBeUndefined();
    expect(error.cause).toBeUndefined();
    expect(error.details).toStrictEqual({ refusal: "outside-execution" });
    expect(Object.keys(error.details ?? {})).toEqual(["refusal"]);
  });

  it("the media type, the size and the cause when given, each its own key", () => {
    const cause = new Error("underneath");
    const withType = fileRefused({
      refusal: FileRefusal.MediaType,
      mediaType: "application/zip",
    });
    const withSize = fileRefused({ refusal: FileRefusal.TooLarge, sizeBytes: 0 });
    const both = fileRefused({
      refusal: FileRefusal.MediaTypeMismatch,
      mediaType: "text/plain",
      sizeBytes: 7,
      cause,
    });

    expect(withType.details).toStrictEqual({ refusal: "media-type", mediaType: "application/zip" });
    expect(withType.mediaType).toBe("application/zip");
    expect(withType.sizeBytes).toBeUndefined();
    expect(withType.message).toBe("the file was refused: media-type");
    expect(withSize.details).toStrictEqual({ refusal: "too-large", sizeBytes: 0 });
    expect(withSize.sizeBytes).toBe(0);
    expect(withSize.mediaType).toBeUndefined();
    expect(both.details).toStrictEqual({
      refusal: "media-type-mismatch",
      mediaType: "text/plain",
      sizeBytes: 7,
    });
    expect(both.cause).toBe(cause);
  });

  it("every refusal has its own wire text", () => {
    expect(Object.values(FileRefusal)).toEqual([
      "outside-execution",
      "media-type",
      "media-type-mismatch",
      "too-large",
      "url-invalid",
      "origin-denied",
      "address-denied",
    ]);
  });
});

describe("FileError.Unavailable", () => {
  it("its message, code, reason, details and cause", () => {
    const cause = new Error("underneath");
    const error = fileUnavailable({
      reason: FileUnavailableReason.DigestMismatch,
      cause,
    });
    const plain = fileUnavailable({ reason: FileUnavailableReason.NotFound });

    expect(error.message).toBe("the file's bytes are unavailable: digest-mismatch");
    expect(error.code).toBe("files.unavailable");
    expect(FileError.Unavailable.code).toBe("files.unavailable");
    expect(error.name).toBe("FileError.Unavailable");
    expect(error.reason).toBe("digest-mismatch");
    expect(error.details).toStrictEqual({ reason: "digest-mismatch" });
    expect(error.cause).toBe(cause);
    expect(plain.cause).toBeUndefined();
    expect(plain.details).toStrictEqual({ reason: "not-found" });
  });

  it("every reason has its own wire text", () => {
    expect(Object.values(FileUnavailableReason)).toEqual([
      "not-found",
      "by-reference",
      "digest-mismatch",
      "outside-execution",
      "too-large",
      "download-failed",
    ]);
  });
});
