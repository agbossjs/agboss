/** H2 (#1413): a pause id is an answer credential: no message, detail or record of an unreadable pause row names it. */
import { describe, expect, it } from "vitest";
import { errorRecordOf } from "../../src/core/error-record.js";
import { StoreError } from "../../src/core/error-families/store-errors.js";
import { parsedStoredJson } from "../../src/core/stored-json.js";
import { pauseKeyOf } from "../../src/infrastructure/pause-record.js";

describe("StoreError.UnreadableRecord", () => {
  it("keeps the ids out of details; a pause is named by its key", () => {
    const secret = "pause-secret-id-77";
    const key = pauseKeyOf("tenant-1", secret);
    let thrown: unknown;
    try {
      parsedStoredJson({ what: "pause", text: "{nope", ids: { pause: key } });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(StoreError.UnreadableRecord);
    const error = thrown as StoreError.UnreadableRecord;
    const seen = JSON.stringify([error.message, error.details, errorRecordOf(error)]);
    expect(seen).not.toContain(secret);
    expect(error.details).not.toHaveProperty("ids");
    expect(error.message).toContain(key);
  });
});
