/** #1269: how one file shows in one view, pinned value by value. */
import { describe, expect, it } from "vitest";
import {
  contentWithPieces,
  headingOf,
  originalPieces,
  ownTranscriptOf,
  sizeOfPiece,
  type FilePlace,
} from "../../src/files/file-pieces.js";
import type { FileContent } from "../../src/files/file-bytes.js";
import { kilobytes } from "../../src/units/index.js";

const content = (mediaType: string, size: number, filename?: string): FileContent => ({
  mediaType,
  bytes: new Uint8Array(size),
  sha256: "s",
  ...(filename === undefined ? {} : { filename }),
});

const place: FilePlace = { field: "document", producer: "start", number: 1, of: 2 };

describe("headingOf", () => {
  it("names the field, the producer, the place, the file's facts and the view", () => {
    expect(headingOf(place, content("application/pdf", 10, "a.pdf"), "original")).toBe(
      "### document (from start, file 1 of 2: a.pdf, application/pdf, 10 B, original)",
    );
  });

  it("leaves the file name out of a file that has none, and 'of' out where the count is unknown", () => {
    expect(headingOf({ ...place, of: undefined }, content("image/png", 0), "original")).toBe(
      "### document (from start, file 1: image/png, 0 B, original)",
    );
  });

  it("gives the size in bytes below a kilobyte and in rounded kilobytes from it", () => {
    const size = (bytes: number): string =>
      headingOf(place, content("image/png", bytes), "v").split(", ")[2] ?? "";

    expect(size(1023)).toBe("1023 B");
    expect(size(1024)).toBe("1 KB");
    expect(size(1535)).toBe("1 KB");
    expect(size(1536)).toBe("2 KB");
    expect(size(86016)).toBe("84 KB");
  });
});

describe("originalPieces", () => {
  const room = kilobytes(8);

  it("gives a text format as its text under its heading, in one piece", () => {
    const text = { ...content("text/plain", 0), bytes: new TextEncoder().encode("hello") };

    expect(originalPieces("H", text, room)).toStrictEqual([{ kind: "text", text: "H\nhello" }]);
    const json = { ...text, mediaType: "application/json" };
    expect(originalPieces("H", json, room)).toStrictEqual([{ kind: "text", text: "H\nhello" }]);
  });

  it("gives a PDF as a file part with its name, and without a name key where it has none", () => {
    const named = content("application/pdf", 3, "a.pdf");
    const anonymous = content("application/pdf", 3);

    expect(originalPieces("H", named, room)).toStrictEqual([
      { kind: "text", text: "H" },
      { kind: "file", mediaType: "application/pdf", filename: "a.pdf", data: "AAAA" },
    ]);
    expect(originalPieces("H", anonymous, room)).toStrictEqual([
      { kind: "text", text: "H" },
      { kind: "file", mediaType: "application/pdf", data: "AAAA" },
    ]);
  });

  it("gives an audio, a video and else an image as the part of that kind", () => {
    const kind = (mediaType: string): unknown =>
      originalPieces("H", content(mediaType, 3), room)[1];

    expect(kind("audio/mpeg")).toStrictEqual({
      kind: "audio",
      mediaType: "audio/mpeg",
      data: "AAAA",
    });
    expect(kind("video/mp4")).toStrictEqual({
      kind: "video",
      mediaType: "video/mp4",
      data: "AAAA",
    });
    expect(kind("image/png")).toStrictEqual({
      kind: "image",
      mediaType: "image/png",
      data: "AAAA",
    });
  });
});

describe("contentWithPieces", () => {
  it("is the plain text where there are no pieces", () => {
    expect(contentWithPieces("hello", [])).toBe("hello");
    expect(contentWithPieces("", [])).toBe("");
  });

  it("is the text block, then a block per piece", () => {
    const part = { kind: "image", mediaType: "image/png", data: "AAAA" } as const;

    expect(contentWithPieces("hello", [{ kind: "text", text: "H" }, part])).toStrictEqual([
      { type: "text", text: "hello" },
      { type: "text", text: "H" },
      { type: "agboss_part", kind: "image", mediaType: "image/png", data: "AAAA" },
    ]);
  });

  it("has no text block for an empty text", () => {
    expect(contentWithPieces("", [{ kind: "text", text: "H" }])).toStrictEqual([
      { type: "text", text: "H" },
    ]);
  });
});

describe("ownTranscriptOf and sizeOfPiece", () => {
  it("a text format transcribes to itself, anything else has no own transcription", () => {
    const text = { ...content("text/csv", 0), bytes: new TextEncoder().encode("a,b") };

    expect(ownTranscriptOf(text)).toBe("a,b");
    expect(ownTranscriptOf(content("image/png", 3))).toBeUndefined();
  });

  it("a text piece adds its UTF-8 bytes, a part the bytes of its file", () => {
    expect(sizeOfPiece({ kind: "text", text: "é€😀" })).toBe(9);
    expect(sizeOfPiece({ kind: "image", mediaType: "image/png", data: "AAAA" })).toBe(3);
    expect(sizeOfPiece({ kind: "file", mediaType: "application/pdf", data: "AAAAAAAA" })).toBe(6);
  });
});
