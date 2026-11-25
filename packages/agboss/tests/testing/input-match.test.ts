/** #262 AC6: the run-time side of PartialValues — values only, lists by position, classes by expect.any. */
import { describe, expect, it } from "vitest";
import { Metadata } from "../../src/flow/metadata.js";
import { inputText, matchesInput, matchesPartial } from "../../src/testing/input-match.js";
import { ChangesRequestedDto, DraftApprovedDto } from "../flow/fixtures/dtos.js";
import { ReviewerAgent } from "../flow/fixtures/offer.fixture.js";

const produced = <TValue extends object>(value: TValue) =>
  Metadata.with(value, { createdBy: ReviewerAgent });

describe("#262 AC6: matching a node's input", () => {
  it("compares values, never producers; undefined matches an absent field only", () => {
    const input = { draft: produced({ text: "v1", notes: "n" }) };

    expect(matchesInput(input, { draft: { text: "v1" } })).toBe(true);
    expect(matchesInput(input, { draft: { text: "v2" } })).toBe(false);
    expect(matchesInput(input, { review: undefined })).toBe(true);
    expect(matchesInput(input, { draft: undefined })).toBe(false);
    expect(matchesInput({}, { draft: { text: "v1" } })).toBe(false);
  });

  it("a list field by length and position; a polymorphic element by its class with expect.any(…)", () => {
    const changes = produced(Object.assign(new ChangesRequestedDto(), { notes: "shorter" }));
    const approved = produced(new DraftApprovedDto());
    const input = { reviews: [changes, approved] };

    expect(matchesInput(input, { reviews: [{ notes: "shorter" }, {}] })).toBe(true);
    expect(matchesInput(input, { reviews: [{}] })).toBe(false);
    expect(matchesInput(input, { reviews: { notes: "shorter" } })).toBe(false);
    expect(
      matchesInput(input, {
        reviews: [expect.any(ChangesRequestedDto), expect.any(DraftApprovedDto)],
      }),
    ).toBe(true);
    expect(
      matchesInput(input, {
        reviews: [expect.any(DraftApprovedDto), expect.any(DraftApprovedDto)],
      }),
    ).toBe(false);
  });

  it("a historyOf field by its current and previous versions", () => {
    const input = {
      draft: { current: produced({ text: "v3" }), previous: [produced({ text: "v2" })] },
    };

    expect(matchesInput(input, { draft: { current: { text: "v3" } } })).toBe(true);
    expect(matchesInput(input, { draft: { previous: [{ text: "v2" }] } })).toBe(true);
    expect(matchesInput(input, { draft: { previous: [] } })).toBe(false);
  });

  it("plain fields as they are; asymmetric matchers match by themselves", () => {
    expect(matchesInput({ query: { q: "TS", page: 2 } }, { query: { q: "TS" } })).toBe(true);
    expect(matchesInput({ query: { q: "TS" } }, { query: expect.anything() })).toBe(true);
    expect(matchesPartial({ text: "long answer" }, { text: expect.stringContaining("long") })).toBe(
      true,
    );
    expect(matchesPartial([1, 2], [1, 2])).toBe(true);
    expect(matchesPartial("x", { text: "x" })).toBe(false);
    expect(matchesPartial([1], [1, 2])).toBe(false);
  });

  it("names an input by its values", () => {
    expect(inputText({ draft: produced({ text: "v1" }) })).toBe('{"draft":{"text":"v1"}}');
    expect(inputText(undefined)).toBe("(no input: not a step of a workflow)");
  });
});
