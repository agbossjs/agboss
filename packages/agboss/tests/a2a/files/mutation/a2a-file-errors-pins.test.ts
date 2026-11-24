/**
 * #1244: the two file errors, pinned exactly: message, code, details (a key only when its value is
 * given), cause and the fields.
 */
import { describe, expect, it } from "vitest";
import {
  A2AFileRefusal,
  A2AFileRefusedError,
  A2AFileUnavailableError,
  A2AFileUnavailableReason,
} from "../../../../src/a2a/files/a2a-file-errors.js";

describe("A2AFileRefusedError", () => {
  it("the refusal alone: its message, code and details, no media type or size", () => {
    const error = new A2AFileRefusedError({ refusal: A2AFileRefusal.OutsideExecution });

    expect(error.message).toBe("the file was refused: outside-execution");
    expect(error.code).toBe("a2a.file-refused");
    expect(A2AFileRefusedError.code).toBe("a2a.file-refused");
    expect(error.name).toBe("A2AFileRefusedError");
    expect(error.refusal).toBe("outside-execution");
    expect(error.mediaType).toBeUndefined();
    expect(error.sizeBytes).toBeUndefined();
    expect(error.cause).toBeUndefined();
    expect(error.details).toStrictEqual({ refusal: "outside-execution" });
    expect(Object.keys(error.details ?? {})).toEqual(["refusal"]);
  });

  it("the media type, the size and the cause when given, each its own key", () => {
    const cause = new Error("underneath");
    const withType = new A2AFileRefusedError({
      refusal: A2AFileRefusal.MediaType,
      mediaType: "application/zip",
    });
    const withSize = new A2AFileRefusedError({ refusal: A2AFileRefusal.TooLarge, sizeBytes: 0 });
    const both = new A2AFileRefusedError({
      refusal: A2AFileRefusal.MediaTypeMismatch,
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
    expect(Object.values(A2AFileRefusal)).toEqual([
      "outside-execution",
      "media-type",
      "media-type-mismatch",
      "too-large",
      "url-invalid",
    ]);
  });
});

describe("A2AFileUnavailableError", () => {
  it("its message, code, reason, details and cause", () => {
    const cause = new Error("underneath");
    const error = new A2AFileUnavailableError({
      reason: A2AFileUnavailableReason.DigestMismatch,
      cause,
    });
    const plain = new A2AFileUnavailableError({ reason: A2AFileUnavailableReason.NotFound });

    expect(error.message).toBe("the file's bytes are unavailable: digest-mismatch");
    expect(error.code).toBe("a2a.file-unavailable");
    expect(A2AFileUnavailableError.code).toBe("a2a.file-unavailable");
    expect(error.name).toBe("A2AFileUnavailableError");
    expect(error.reason).toBe("digest-mismatch");
    expect(error.details).toStrictEqual({ reason: "digest-mismatch" });
    expect(error.cause).toBe(cause);
    expect(plain.cause).toBeUndefined();
    expect(plain.details).toStrictEqual({ reason: "not-found" });
  });

  it("every reason has its own wire text", () => {
    expect(Object.values(A2AFileUnavailableReason)).toEqual([
      "not-found",
      "by-reference",
      "digest-mismatch",
      "outside-execution",
      "too-large",
      "download-failed",
    ]);
  });
});
