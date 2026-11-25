/** #1269: the errors of a file on its way to a model: their codes, names, messages, fields, causes and details. */
import { StepError } from "../../src/core/error-families/step-errors.js";
import { FileError } from "../../src/core/error-families/remote-errors.js";
import { fileRefused, fileUnavailable } from "../../src/files/file-errors.js";
import { describe, expect, it } from "vitest";
import { FileRefusal, FileUnavailableReason } from "../../src/files/file-errors.js";
import { ModelFileLimit } from "../../src/files/model-files.js";

describe("#1269: FileError.Unavailable", () => {
  it("says why in its message, its reason and its details; keeps the cause", () => {
    const cause = new Error("boom");
    const error = fileUnavailable({
      reason: FileUnavailableReason.DigestMismatch,
      cause,
    });

    expect(error.message).toBe("the file's bytes are unavailable: digest-mismatch");
    expect(error.reason).toBe("digest-mismatch");
    expect(error.code).toBe("files.unavailable");
    expect(error.details).toEqual({ reason: "digest-mismatch" });
    expect(error.cause).toBe(cause);
  });
});

describe("#1269: FileError.Refused", () => {
  it("says what was refused in its message, its refusal and its details; keeps the cause", () => {
    const cause = new Error("denied");
    const error = fileRefused({ refusal: FileRefusal.TooLarge, cause });

    expect(error.message).toBe("the file was refused: too-large");
    expect(error.refusal).toBe("too-large");
    expect(error.code).toBe("files.refused");
    expect(error.details).toEqual({ refusal: "too-large" });
    expect(error.cause).toBe(cause);
  });
});

describe("#1269: StepError.ModelFileLimit", () => {
  const options = {
    agent: "reader",
    limit: ModelFileLimit.MaxFileSize,
    actual: 2048,
    allowed: 1024,
  };

  it("names the agent, the limit, what it was and what is allowed", () => {
    const error = new StepError.ModelFileLimit(options);

    expect(error.name).toBe("StepError.ModelFileLimit");
    expect(error.code).toBe("step.model-file-limit");
    expect(error.message).toBe(
      'Agent "reader": its files are over a limit — max-file-size: 2048 is over 1024',
    );
    expect(error.cause).toBe("max-file-size: 2048 is over 1024");
    expect(error.details).toMatchObject({
      agent: "reader",
      limit: "max-file-size",
      actual: 2048,
      allowed: 1024,
    });
    expect([error.agent, error.limit, error.actual, error.allowed]).toEqual([
      "reader",
      "max-file-size",
      2048,
      1024,
    ]);
    expect(error.usage).toEqual([]);
  });

  it("keeps the cause it is given instead of its sentence", () => {
    const cause = new Error("the real one");

    expect(new StepError.ModelFileLimit({ ...options, cause }).cause).toBe(cause);
  });

  it("states a media type limit with its text values", () => {
    const error = new StepError.ModelFileLimit({
      agent: "reader",
      limit: ModelFileLimit.MediaType,
      actual: "image/gif",
      allowed: "image/png",
    });

    expect(error.cause).toBe("media-type: image/gif is over image/png");
  });
});

describe("#1269: StepError.FileMaskingFailed", () => {
  it("names the agent and the reason; the reason is its cause unless one is given", () => {
    const error = new StepError.FileMaskingFailed({ agent: "reader", reason: "the model said no" });

    expect(error.name).toBe("StepError.FileMaskingFailed");
    expect(error.code).toBe("step.file-masking-failed");
    expect(error.message).toBe(
      'Agent "reader": a redacted copy of its file could not be made — the model said no',
    );
    expect(error.cause).toBe("the model said no");
    expect(error.details).toMatchObject({ agent: "reader", reason: "the model said no" });
    expect([error.agent, error.reason]).toEqual(["reader", "the model said no"]);
    expect(error.usage).toEqual([]);
  });

  it("keeps the cause it is given", () => {
    const cause = new Error("sharp failed");

    expect(new StepError.FileMaskingFailed({ agent: "a", reason: "r", cause }).cause).toBe(cause);
  });
});
