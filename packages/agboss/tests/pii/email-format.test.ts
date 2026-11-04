/**
 * #729 — the e-mail format detector finds the address, never a file extension after it: the last
 * label of a domain ends at a label boundary and is no common file extension that is not a
 * top-level domain; a real domain, however many labels, is found whole.
 */
import { describe, expect, it } from "vitest";
import { findFormatRanges } from "../../src/pii/detectors/find.js";
import { PiiKind } from "../../src/pii/kinds.js";
import { testPii } from "../../src/testing/index.js";
import { ContactPiiPolicy } from "../testing/fixtures/units.js";

const EMAIL = new Set([PiiKind.Email]);

/** The addresses the detector finds in `text`. */
const emailsIn = (text: string): readonly string[] =>
  findFormatRanges(text, EMAIL).map(({ start, end }) => text.slice(start, end));

describe("#729 AC1: a file named after an address", () => {
  it.each([
    ["export of anna@acme.com.pdf attached", "anna@acme.com"],
    ["anna@acme.com.CSV", "anna@acme.com"],
    ["clip anna@acme.com.mp4", "anna@acme.com"],
    ["notes in anna@mail.acme.co.uk.docx", "anna@mail.acme.co.uk"],
  ])("%s → %s", (text, address) => {
    expect(emailsIn(text)).toEqual([address]);
  });

  it("the extension stays as it is: a token for the address, .pdf after it", async () => {
    const pii = testPii([ContactPiiPolicy]);

    const { output } = await pii.mask("see anna@acme.com.pdf");

    expect(output).toMatch(/^see <email:[0-9a-f]{6,}>\.pdf$/u);
  });
});

describe("#729 AC2: real domains as before", () => {
  it.each([
    ["anna@mail.acme.co.uk", "anna@mail.acme.co.uk"],
    ["write to anna@acme.io.", "anna@acme.io"],
    ["anna@acme.md", "anna@acme.md"],
    ["anna@acme.com.zip", "anna@acme.com.zip"],
    ["(anna@acme.com)", "anna@acme.com"],
  ])("%s → %s", (text, address) => {
    expect(emailsIn(text)).toEqual([address]);
  });
});
