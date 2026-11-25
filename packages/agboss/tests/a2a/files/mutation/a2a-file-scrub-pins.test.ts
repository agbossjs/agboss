/**
 * #1244: the scrub walks, pinned: what counts as a descriptor, the depth they stop at, symbol keys,
 * messages with file parts, and the DTO-guided scrub on every shape of value.
 */
import { HumanMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { FileDto } from "../../../../src/dto/standard/file.js";
import {
  isFileDescriptor,
  redactedFilesIn,
  scrubbedFilesOfDto,
  withoutInlineBytes,
} from "../../../../src/a2a/files/a2a-file-scrub.js";
import { Integer, Nested, Text } from "../../../../src/dto/decorators.js";
import { ReviewRequestDto } from "../../fixtures/files.application.js";

const SHA = "b".repeat(64);
const stored = { mediaType: "application/pdf", fileId: "f1", sha256: SHA, sizeBytes: 9 };
const storedShown = {
  mediaType: "application/pdf",
  sha256: SHA,
  sizeBytes: 9,
  source: "stored",
};
const TOO_DEEP = "[too deep]";

describe("isFileDescriptor", () => {
  it("a plain record with a media type and exactly one string source", () => {
    expect(isFileDescriptor({ mediaType: "a/b", fileId: "f" })).toBe(true);
    expect(isFileDescriptor({ mediaType: "a/b", inline: "" })).toBe(true);
    expect(isFileDescriptor({ mediaType: "a/b", url: "https://x.example" })).toBe(true);
    expect(
      isFileDescriptor(Object.assign(Object.create(null), { mediaType: "a/b", url: "u" })),
    ).toBe(true);
  });

  it("not: no or two sources, a source or media type that is no string, not a plain record", () => {
    class Holder {
      mediaType = "a/b";
      url = "u";
    }
    expect(isFileDescriptor({ mediaType: "a/b" })).toBe(false);
    expect(isFileDescriptor({ mediaType: "a/b", fileId: "f", url: "u" })).toBe(false);
    expect(isFileDescriptor({ mediaType: "a/b", fileId: "f", inline: "i", url: "u" })).toBe(false);
    expect(isFileDescriptor({ mediaType: "a/b", url: 5 })).toBe(false);
    expect(isFileDescriptor({ mediaType: 5, url: "u" })).toBe(false);
    expect(isFileDescriptor({ url: "u" })).toBe(false);
    expect(isFileDescriptor(new Holder())).toBe(false);
    expect(isFileDescriptor(Object.assign([], { mediaType: "a/b", url: "u" }))).toBe(false);
    expect(isFileDescriptor(null)).toBe(false);
    expect(isFileDescriptor("a/b")).toBe(false);
    expect(isFileDescriptor(undefined)).toBe(false);
  });
});

describe("redactedFilesIn and withoutInlineBytes", () => {
  it("a descriptor anywhere in plain data, in lists and records; the rest as it is", () => {
    const value = { a: [stored, { b: stored }], n: 1, s: "x", z: null, u: undefined };

    expect(redactedFilesIn(value)).toStrictEqual({
      a: [storedShown, { b: storedShown }],
      n: 1,
      s: "x",
      z: null,
      u: undefined,
    });
  });

  it("an object that is no plain record is kept as it is, its descriptors inside too", () => {
    const date = new Date(0);
    class Box {
      readonly file = stored;
    }
    const box = new Box();

    expect(redactedFilesIn(date)).toBe(date);
    expect(redactedFilesIn(box)).toBe(box);
    expect(redactedFilesIn("text")).toBe("text");
  });

  it("without the inline bytes: the descriptor otherwise whole", () => {
    const file = { mediaType: "text/plain", inline: "aGk=", sha256: SHA, sizeBytes: 2 };

    expect(withoutInlineBytes({ list: [file], file })).toStrictEqual({
      list: [{ mediaType: "text/plain", sha256: SHA, sizeBytes: 2 }],
      file: { mediaType: "text/plain", sha256: SHA, sizeBytes: 2 },
    });
    expect(withoutInlineBytes({ mediaType: "a/b", url: "https://x.example" })).toStrictEqual({
      mediaType: "a/b",
      url: "https://x.example",
    });
  });

  it("symbol keys of a record are kept as they are, with their descriptor", () => {
    const brand = Symbol("brand");
    const value: Record<string | symbol, unknown> = { file: stored };
    Object.defineProperty(value, brand, { value: "variant", enumerable: false });

    const shown = redactedFilesIn(value);

    expect(shown).toStrictEqual({ file: storedShown });
    expect(Object.getOwnPropertySymbols(shown)).toEqual([brand]);
    expect(Object.getOwnPropertyDescriptor(shown, brand)).toEqual({
      value: "variant",
      enumerable: false,
      writable: false,
      configurable: false,
    });
  });

  it("a message to a model shows its file parts as their meta, never their bytes", () => {
    const part = {
      type: "agboss_part",
      kind: "file",
      mediaType: "application/pdf",
      data: Buffer.from("hello").toString("base64"),
      filename: "a.pdf",
    };
    const text = { type: "text", text: "hi" };
    const meta = {
      type: "agboss_part",
      kind: "file",
      mediaType: "application/pdf",
      filename: "a.pdf",
      sizeBytes: 5,
      sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    };

    const shown = redactedFilesIn(new HumanMessage({ content: [text, part] }));

    expect(shown).toBeInstanceOf(HumanMessage);
    expect((shown as HumanMessage).content).toEqual([text, meta]);
    expect(redactedFilesIn({ block: part, list: [part] })).toStrictEqual({
      block: meta,
      list: [meta],
    });
  });
});

/** `levels` arrays (or records) around a descriptor. */
function wrapped(levels: number, as: "list" | "record"): unknown {
  let value: unknown = stored;
  for (let level = 0; level < levels; level += 1) value = as === "list" ? [value] : { next: value };
  return value;
}
function leafOf(value: unknown, levels: number, as: "list" | "record"): unknown {
  let at = value;
  for (let level = 0; level < levels; level += 1)
    at = as === "list" ? (at as unknown[])[0] : (at as { next: unknown }).next;
  return at;
}

describe("the depth the walks stop at", () => {
  for (const as of ["list", "record"] as const) {
    it(`${as}s: the 64th level still shows its descriptor, the 65th is too deep`, () => {
      expect(leafOf(redactedFilesIn(wrapped(64, as)), 64, as)).toStrictEqual(storedShown);
      expect(leafOf(redactedFilesIn(wrapped(65, as)), 65, as)).toBe(TOO_DEEP);
      expect(leafOf(withoutInlineBytes(wrapped(65, as)), 65, as)).toBe(TOO_DEEP);
    });
  }
});

class ChildDto {
  @Text({ prompt: "t" })
  label!: string;

  @Nested(FileDto, { prompt: "f", optional: true })
  file?: FileDto;
}
class ParentDto {
  @Nested(ChildDto, { prompt: "c" })
  child!: ChildDto;

  @Integer({ prompt: "n" })
  count!: number;
}

describe("scrubbedFilesOfDto", () => {
  it("a file DTO's place: a descriptor as shown, anything else without its sources", () => {
    expect(scrubbedFilesOfDto(FileDto, stored)).toStrictEqual(storedShown);
    expect(
      scrubbedFilesOfDto(FileDto, { fileId: "f", inline: "b", url: "u", note: "n", other: 1 }),
    ).toStrictEqual({ note: "n", other: 1 });
    expect(scrubbedFilesOfDto(FileDto, { mediaType: "a/b" })).toStrictEqual({
      mediaType: "a/b",
    });
  });

  it("a list: each item by the same DTO", () => {
    expect(scrubbedFilesOfDto(FileDto, [stored, { url: "u" }])).toStrictEqual([storedShown, {}]);
  });

  it("a value that is no plain record is returned as it is", () => {
    const date = new Date(0);
    expect(scrubbedFilesOfDto(FileDto, "text")).toBe("text");
    expect(scrubbedFilesOfDto(ParentDto, "text")).toBe("text");
    expect(scrubbedFilesOfDto(ParentDto, 5)).toBe(5);
    expect(scrubbedFilesOfDto(ParentDto, date)).toBe(date);
    expect(scrubbedFilesOfDto(ParentDto, null)).toBeNull();
    expect(scrubbedFilesOfDto(ParentDto, undefined)).toBeUndefined();
  });

  it("a DTO: the fields that are DTOs by their DTO, others and unknown keys as they are", () => {
    const value = { child: { label: "x", file: stored, extra: 1 }, count: 2, unknown: [1] };

    expect(scrubbedFilesOfDto(ParentDto, value)).toStrictEqual({
      child: { label: "x", file: storedShown, extra: 1 },
      count: 2,
      unknown: [1],
    });
  });

  it("the review request: the file, the listed pages, the note", () => {
    const inline = { mediaType: "text/plain", inline: "aGk=", sha256: SHA, sizeBytes: 2 };

    expect(
      scrubbedFilesOfDto(ReviewRequestDto, {
        document: inline,
        pages: [stored, inline],
        note: "n",
      }),
    ).toStrictEqual({
      document: { mediaType: "text/plain", sha256: SHA, sizeBytes: 2, source: "inline" },
      pages: [
        storedShown,
        { mediaType: "text/plain", sha256: SHA, sizeBytes: 2, source: "inline" },
      ],
      note: "n",
    });
  });

  it("symbol keys of the record are kept", () => {
    const brand = Symbol("brand");
    const value: Record<string | symbol, unknown> = { count: 1 };
    value[brand] = "variant";

    const scrubbed = scrubbedFilesOfDto(ParentDto, value);

    expect(Object.getOwnPropertySymbols(scrubbed)).toEqual([brand]);
  });
});
