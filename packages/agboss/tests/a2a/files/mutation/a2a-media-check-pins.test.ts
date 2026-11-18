/**
 * #1244: the media check of a file's bytes, pinned byte by byte — each signature on its exact
 * bytes (and no longer), altered at every position, cut short, at the wrong offset.
 */
import { describe, expect, it } from "vitest";
import { isOfMediaType, utf8Of } from "../../../../src/a2a/files/a2a-media-check.js";

const ascii = (text: string): number[] => [...Buffer.from(text, "latin1")];
const bytesOf = (...parts: readonly (readonly number[])[]): Uint8Array =>
  Uint8Array.from(parts.flat());
const zeros = (count: number): number[] => new Array<number>(count).fill(0);

/** The signature on its own, then altered at each position, then cut by one byte. */
function expectSignature(mediaTypes: readonly string[], signature: readonly number[]): void {
  for (const mediaType of mediaTypes) {
    expect(isOfMediaType(mediaType, bytesOf(signature)), `${mediaType} exact`).toBe(true);
    expect(isOfMediaType(mediaType, bytesOf(signature, [1, 2, 3])), `${mediaType} longer`).toBe(
      true,
    );
    expect(isOfMediaType(mediaType, bytesOf(signature.slice(0, -1))), `${mediaType} cut`).toBe(
      false,
    );
    expect(isOfMediaType(mediaType, bytesOf([])), `${mediaType} empty`).toBe(false);
    signature.forEach((byte, index) => {
      for (const changed of [byte + 1, byte - 1]) {
        const altered = [...signature];
        altered[index] = (changed + 256) % 256;
        expect(
          isOfMediaType(mediaType, bytesOf(altered)),
          `${mediaType} byte ${String(index)}`,
        ).toBe(false);
      }
    });
  }
}

describe("signatures at offset 0", () => {
  it("png", () => {
    expectSignature(["image/png"], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });
  it("jpeg", () => {
    expectSignature(["image/jpeg"], [0xff, 0xd8, 0xff]);
  });
  it("gif, both versions", () => {
    expectSignature(["image/gif"], ascii("GIF87a"));
    expectSignature(["image/gif"], ascii("GIF89a"));
  });
  it("pdf", () => {
    expectSignature(["application/pdf"], ascii("%PDF-"));
  });
  it("ogg and flac", () => {
    expectSignature(["audio/ogg"], ascii("OggS"));
    expectSignature(["audio/flac"], ascii("fLaC"));
  });
  it("webm and matroska", () => {
    expectSignature(["video/webm", "video/x-matroska"], [0x1a, 0x45, 0xdf, 0xa3]);
  });
  it("mp3 by its ID3 tag", () => {
    expectSignature(["audio/mpeg", "audio/mp3"], ascii("ID3"));
  });
});

describe("riff containers", () => {
  const riff = (kind: string): Uint8Array => bytesOf(ascii("RIFF"), zeros(4), ascii(kind));

  it("webp is RIFF at 0 and WEBP at 8, wav RIFF at 0 and WAVE at 8", () => {
    expect(isOfMediaType("image/webp", riff("WEBP"))).toBe(true);
    expect(isOfMediaType("audio/wav", riff("WAVE"))).toBe(true);
    expect(isOfMediaType("audio/x-wav", riff("WAVE"))).toBe(true);
    expect(isOfMediaType("image/webp", riff("WAVE"))).toBe(false);
    expect(isOfMediaType("audio/wav", riff("WEBP"))).toBe(false);
    expect(isOfMediaType("audio/x-wav", riff("WEBP"))).toBe(false);
  });

  it("each half is needed: the brand without RIFF, RIFF without the brand, a short file", () => {
    for (const [mediaType, kind] of [
      ["image/webp", "WEBP"],
      ["audio/wav", "WAVE"],
    ] as const) {
      expect(isOfMediaType(mediaType, bytesOf(ascii("RIFX"), zeros(4), ascii(kind)))).toBe(false);
      expect(isOfMediaType(mediaType, bytesOf(ascii("RIFF"), zeros(4), ascii("XXXX")))).toBe(false);
      expect(isOfMediaType(mediaType, bytesOf(zeros(8), ascii(kind)))).toBe(false);
      expect(
        isOfMediaType(mediaType, bytesOf(ascii("RIFF"), zeros(4), ascii(kind).slice(0, 3))),
      ).toBe(false);
      expect(isOfMediaType(mediaType, bytesOf(ascii("RIFF")))).toBe(false);
      expect(isOfMediaType(mediaType, bytesOf(ascii(kind), zeros(8)))).toBe(false);
    }
  });
});

describe("mp3 and aac frame sync", () => {
  it("mp3: 0xff then the top three bits set", () => {
    for (const mediaType of ["audio/mpeg", "audio/mp3"]) {
      expect(isOfMediaType(mediaType, bytesOf([0xff, 0xe0]))).toBe(true);
      expect(isOfMediaType(mediaType, bytesOf([0xff, 0xfb, 0x90]))).toBe(true);
      expect(isOfMediaType(mediaType, bytesOf([0xff, 0xc0]))).toBe(false);
      expect(isOfMediaType(mediaType, bytesOf([0xff, 0x00]))).toBe(false);
      expect(isOfMediaType(mediaType, bytesOf([0x00, 0xe0]))).toBe(false);
      expect(isOfMediaType(mediaType, bytesOf([0xfe, 0xe0]))).toBe(false);
      expect(isOfMediaType(mediaType, bytesOf([0x00, 0x00]))).toBe(false);
      expect(isOfMediaType(mediaType, bytesOf([0xff]))).toBe(false);
      expect(isOfMediaType(mediaType, bytesOf([]))).toBe(false);
    }
  });

  it("aac (ADTS): 0xff, then the sync bits and a zero layer; ID and protection bits free", () => {
    expect(isOfMediaType("audio/aac", bytesOf([0xff, 0xf0]))).toBe(true);
    expect(isOfMediaType("audio/aac", bytesOf([0xff, 0xf1, 0x50]))).toBe(true);
    expect(isOfMediaType("audio/aac", bytesOf([0xff, 0xf2]))).toBe(false);
    expect(isOfMediaType("audio/aac", bytesOf([0xff, 0xf4]))).toBe(false);
    expect(isOfMediaType("audio/aac", bytesOf([0xff, 0xe0]))).toBe(false);
    expect(isOfMediaType("audio/aac", bytesOf([0xff, 0x00]))).toBe(false);
    expect(isOfMediaType("audio/aac", bytesOf([0x00, 0xf0]))).toBe(false);
    expect(isOfMediaType("audio/aac", bytesOf([0xfe, 0xf0]))).toBe(false);
    expect(isOfMediaType("audio/aac", bytesOf([0x00, 0x00]))).toBe(false);
    expect(isOfMediaType("audio/aac", bytesOf([0xff]))).toBe(false);
    expect(isOfMediaType("audio/aac", bytesOf([]))).toBe(false);
  });
});

describe("iso base media (ftyp at 4, the brand at 8)", () => {
  const iso = (brand: string): Uint8Array =>
    bytesOf(zeros(4), ascii("ftyp"), ascii(brand), zeros(4));
  const AUDIO = ["audio/mp4", "audio/m4a"];
  const VIDEO = ["video/mp4", "video/quicktime"];

  it("an audio brand is audio, any other brand is video", () => {
    for (const brand of ["M4A ", "M4B "]) {
      for (const mediaType of AUDIO) expect(isOfMediaType(mediaType, iso(brand))).toBe(true);
      for (const mediaType of VIDEO) expect(isOfMediaType(mediaType, iso(brand))).toBe(false);
    }
    for (const brand of ["isom", "mp42", "qt  "]) {
      for (const mediaType of AUDIO) expect(isOfMediaType(mediaType, iso(brand))).toBe(false);
      for (const mediaType of VIDEO) expect(isOfMediaType(mediaType, iso(brand))).toBe(true);
    }
  });

  it("without ftyp at byte 4 it is neither, whatever the brand", () => {
    for (const bytes of [
      bytesOf(zeros(4), ascii("ftyx"), ascii("M4A "), zeros(4)),
      bytesOf(zeros(4), ascii("ftyx"), ascii("isom"), zeros(4)),
      bytesOf(zeros(3), ascii("ftyp"), ascii("M4A "), zeros(4)),
      bytesOf(ascii("ftyp"), ascii("isom"), zeros(4)),
      bytesOf([]),
    ])
      for (const mediaType of [...AUDIO, ...VIDEO])
        expect(isOfMediaType(mediaType, bytes)).toBe(false);
  });

  it("the brand is compared whole: a prefix of it is not it", () => {
    expect(isOfMediaType("audio/mp4", bytesOf(zeros(4), ascii("ftyp"), ascii("M4A")))).toBe(false);
    expect(isOfMediaType("video/mp4", bytesOf(zeros(4), ascii("ftyp"), ascii("M4A")))).toBe(true);
    expect(isOfMediaType("audio/mp4", bytesOf(zeros(4), ascii("ftyp"), ascii("M4B")))).toBe(false);
  });
});

describe("text and json", () => {
  it("text is valid UTF-8, the empty file included", () => {
    for (const mediaType of ["text/plain", "text/markdown", "text/csv"]) {
      expect(isOfMediaType(mediaType, bytesOf(ascii("hello")))).toBe(true);
      expect(isOfMediaType(mediaType, new TextEncoder().encode("привет"))).toBe(true);
      expect(isOfMediaType(mediaType, bytesOf([]))).toBe(true);
      expect(isOfMediaType(mediaType, bytesOf([0xff, 0xfe]))).toBe(false);
      expect(isOfMediaType(mediaType, bytesOf([0xc3]))).toBe(false);
    }
  });

  it("json parses; invalid UTF-8 and invalid JSON are not", () => {
    expect(isOfMediaType("application/json", bytesOf(ascii('{"a":1}')))).toBe(true);
    expect(isOfMediaType("application/json", bytesOf(ascii("null")))).toBe(true);
    expect(isOfMediaType("application/json", bytesOf(ascii("{")))).toBe(false);
    expect(isOfMediaType("application/json", bytesOf(ascii("")))).toBe(false);
    expect(isOfMediaType("application/json", bytesOf([0xff, 0x7b, 0x7d]))).toBe(false);
    expect(isOfMediaType("application/json", bytesOf([0x22, 0xc3, 0x22]))).toBe(false);
  });

  it("utf8Of is the text, or undefined", () => {
    expect(utf8Of(bytesOf(ascii("ab")))).toBe("ab");
    expect(utf8Of(bytesOf([]))).toBe("");
    expect(utf8Of(bytesOf([0xff]))).toBeUndefined();
  });
});

describe("a media type with no check", () => {
  it("is taken as declared, and only an own key is a check", () => {
    for (const mediaType of [
      "application/zip",
      "",
      "toString",
      "constructor",
      "__proto__",
      "hasOwnProperty",
    ])
      expect(isOfMediaType(mediaType, bytesOf([1, 2, 3]))).toBe(true);
  });

  it("a type is compared as given: a lower-case essence", () => {
    expect(isOfMediaType("IMAGE/PNG", bytesOf([1, 2, 3]))).toBe(true);
    expect(isOfMediaType("image/png", bytesOf([1, 2, 3]))).toBe(false);
  });

  it("each checked type rejects the bytes of the others", () => {
    const types = [
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
      "application/pdf",
      "audio/mpeg",
      "audio/wav",
      "audio/ogg",
      "audio/flac",
      "audio/aac",
      "audio/mp4",
      "video/mp4",
      "video/webm",
    ];
    for (const mediaType of types)
      expect(
        isOfMediaType(
          mediaType,
          bytesOf([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c]),
        ),
      ).toBe(false);
  });
});
