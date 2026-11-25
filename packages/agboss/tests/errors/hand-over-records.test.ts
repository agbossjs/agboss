/** #1413 M5: a stopping application's record is a hand-over record, whichever class threw it. */
import { describe, expect, it } from "vitest";
import { ApplicationStoppingError } from "../../src/core/errors.js";
import { errorRecordOf } from "../../src/core/error-record.js";
import { isHandOverRecord } from "../../src/core/error-families/hand-over.js";
import { ExecutionError } from "../../src/core/error-families/run-errors.js";

describe("isHandOverRecord", () => {
  it("takes the record of the standalone ApplicationStoppingError", () => {
    expect(
      isHandOverRecord(errorRecordOf(new ApplicationStoppingError({ message: "closing" }))),
    ).toBe(true);
  });

  it("takes the record of ExecutionError.ApplicationStopping, and not a plain failure", () => {
    expect(isHandOverRecord(errorRecordOf(new ExecutionError.ApplicationStopping()))).toBe(true);
    expect(
      isHandOverRecord(errorRecordOf(new ExecutionError.OutputInvalid({ message: "x" }))),
    ).toBe(false);
  });
});
