/**
 * #934 AC3, the refusals: a stored value that is neither the 0.1.0 shape nor the new one is
 * unreadable — the error names the record's id and the field, never a stored value. The values are
 * parsed JSON, as a store hands them over.
 */
import { describe, expect, it } from "vitest";
import {
  executionHistoryRecordOfStored,
  pauseAnswerRecordOfStored,
  StoredNamesUnreadableError,
} from "../../src/infrastructure/stored-step.js";

const ENTRY = '{"executionId":"run-1","role":"r","resolution":"replied","askedAt":"t"';

describe("AC3: an entry that is neither shape is unreadable", () => {
  it("a 0.1.0 entry whose answeredBy is no kind: the id and the field, not the value", () => {
    const stored = JSON.parse(`${ENTRY},"answeredBy":"secret-value-42"}`);
    const refused = (): unknown => pauseAnswerRecordOfStored(stored);
    expect(refused).toThrow(StoredNamesUnreadableError);
    expect(refused).toThrow(/run-1.*answeredBy/);
    expect(refused).not.toThrow(/secret-value-42/);
  });

  it("a history record whose pauses are no list: the id and the field", () => {
    const stored = JSON.parse('{"executionId":"run-9","pauses":"nope","children":[]}');
    expect(() => executionHistoryRecordOfStored(stored)).toThrow(/run-9.*pauses/);
  });
});
