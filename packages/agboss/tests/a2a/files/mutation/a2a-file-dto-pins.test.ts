/**
 * #1244: the file DTO, pinned: the descriptor's rule (which field and which reason), the scrubbed
 * shape, and the file fields of a DTO at the top level and below it.
 */
import { ValidationError } from "../../../../src/index.js";
import { describe, expect, it } from "vitest";
import {
  FileDto,
  FilePayloadSource,
  fileFieldsOf,
  fileSourceOf,
  hasFileAtAnyDepth,
  nestedFileFieldsOf,
  redactedFileOf,
} from "../../../../src/dto/standard/file.js";
import { Nested, Text } from "../../../../src/dto/decorators.js";
import { fieldsOf, recordField } from "../../../../src/dto/metadata.js";
import { validate } from "../../../../src/dto/schema.js";
import { METADATA_KEY } from "../../../../src/polyfills/symbol-metadata.js";
import { ReviewRequestDto } from "../../fixtures/files.application.js";

const SHA = "a".repeat(64);

function issuesOf(raw: unknown): readonly { path: string; reason: string }[] {
  try {
    validate(FileDto, raw);
  } catch (error) {
    if (error instanceof ValidationError.DtoInvalid) return error.issues;
    throw error;
  }
  return [];
}

describe("the descriptor's rule", () => {
  it("not exactly one source: fileId, with its reason", () => {
    const reason = "a file is exactly one of fileId, inline or url";
    expect(issuesOf({ mediaType: "text/plain" })).toEqual([{ path: "fileId", reason }]);
    expect(
      issuesOf({ mediaType: "text/plain", fileId: "f", url: "https://a.example/x", sha256: SHA }),
    ).toEqual([{ path: "fileId", reason }]);
  });

  it("a url is http(s), case-insensitively, at its start", () => {
    const reason = "a file's url is an http(s) URL";
    for (const url of ["http://a.example/x", "https://a.example/x", "HTTPS://a.example/x"])
      expect(issuesOf({ mediaType: "text/plain", url }), url).toEqual([]);
    for (const url of ["ftp://a.example/https://x", "file:///etc/passwd", "xhttps://a.example"])
      expect(issuesOf({ mediaType: "text/plain", url }), url).toEqual([{ path: "url", reason }]);
  });

  it("bytes name their digest, then their size", () => {
    expect(issuesOf({ mediaType: "text/plain", inline: "aGk=", sizeBytes: 2 })).toEqual([
      { path: "sha256", reason: "a file's bytes need sha256" },
    ]);
    expect(issuesOf({ mediaType: "text/plain", fileId: "f", sha256: SHA })).toEqual([
      { path: "sizeBytes", reason: "a file's bytes need sizeBytes" },
    ]);
    expect(issuesOf({ mediaType: "text/plain", fileId: "f", sha256: SHA, sizeBytes: 0 })).toEqual(
      [],
    );
  });
});

describe("redactedFileOf", () => {
  const base = { mediaType: "text/plain" };

  it("the media type and the source only, each optional key only when set", () => {
    expect(redactedFileOf({ ...base, url: "https://a.example/x" })).toStrictEqual({
      mediaType: "text/plain",
      source: FilePayloadSource.Url,
    });
    expect(redactedFileOf({ ...base, fileId: "f" })).toStrictEqual({
      mediaType: "text/plain",
      source: FilePayloadSource.Stored,
    });
    expect(redactedFileOf({ ...base, inline: "aGk=" })).toStrictEqual({
      mediaType: "text/plain",
      source: FilePayloadSource.Inline,
    });
  });

  it("each of the name, the size (0 too) and the digest by itself", () => {
    const file = { ...base, inline: "aGk=" };

    expect(redactedFileOf({ ...file, filename: "a.txt" })).toStrictEqual({
      mediaType: "text/plain",
      filename: "a.txt",
      source: "inline",
    });
    expect(redactedFileOf({ ...file, sizeBytes: 0 })).toStrictEqual({
      mediaType: "text/plain",
      sizeBytes: 0,
      source: "inline",
    });
    expect(redactedFileOf({ ...file, sha256: SHA })).toStrictEqual({
      mediaType: "text/plain",
      sha256: SHA,
      source: "inline",
    });
  });

  it("a file id wins over inline in the source", () => {
    expect(fileSourceOf({ ...base, fileId: "f", inline: "x" })).toBe(FilePayloadSource.Stored);
  });
});

class PlainDto {
  @Text({ prompt: "t" })
  label!: string;
}
class InnerDto {
  @Nested(FileDto, { prompt: "f" })
  file!: FileDto;
}
class MidDto {
  @Nested(InnerDto, { prompt: "i" })
  inner!: InnerDto;
}
class TopDto {
  @Nested(MidDto, { prompt: "m" })
  mid!: MidDto;

  @Nested(PlainDto, { prompt: "p" })
  plain!: PlainDto;
}
class SubFileDto extends FileDto {}
class WithSubDto {
  @Nested(SubFileDto, { prompt: "s" })
  sub!: SubFileDto;
}

// a class cannot name itself in its own decorator: a cycle is closed in the field table
class CycleMidDto {
  @Nested(FileDto, { prompt: "f" })
  file!: FileDto;

  @Nested(PlainDto, { prompt: "p", optional: true })
  top?: PlainDto;
}
class CycleTopDto {
  @Nested(FileDto, { prompt: "f" })
  file!: FileDto;

  @Nested(CycleMidDto, { prompt: "m" })
  mid!: CycleMidDto;
}
class DeepInnerDto {
  @Nested(FileDto, { prompt: "f" })
  file!: FileDto;

  @Nested(PlainDto, { prompt: "p", optional: true })
  back?: PlainDto;
}
class DeepMidDto {
  @Nested(DeepInnerDto, { prompt: "i" })
  inner!: DeepInnerDto;
}
class DeepTopDto {
  @Nested(DeepMidDto, { prompt: "m" })
  mid!: DeepMidDto;
}
function closeCycle(from: new () => object, field: string, to: new () => object): void {
  const link = fieldsOf(from).find((each) => each.name === field);
  if (link === undefined) throw new Error("no field");
  recordField(Reflect.get(from, METADATA_KEY), { ...link, element: { kind: "dto", dto: to } });
}
closeCycle(CycleMidDto, "top", CycleTopDto);
closeCycle(DeepInnerDto, "back", DeepMidDto);

describe("fileFieldsOf", () => {
  it("the file fields in order: one, a list, optional; no scalar and no other DTO", () => {
    expect(fileFieldsOf(ReviewRequestDto)).toEqual([
      { name: "document", isList: false, isOptional: false },
      { name: "pages", isList: true, isOptional: true },
    ]);
    expect(fileFieldsOf(TopDto)).toEqual([]);
    expect(fileFieldsOf(PlainDto)).toEqual([]);
    expect(fileFieldsOf(WithSubDto)).toEqual([{ name: "sub", isList: false, isOptional: false }]);
  });
});

describe("hasFileAtAnyDepth", () => {
  it("at the top, below, through a subclass; not in a DTO without", () => {
    expect(hasFileAtAnyDepth(FileDto)).toBe(true);
    expect(hasFileAtAnyDepth(TopDto)).toBe(true);
    expect(hasFileAtAnyDepth(WithSubDto)).toBe(true);
    expect(hasFileAtAnyDepth(PlainDto)).toBe(false);
  });
});

describe("nestedFileFieldsOf", () => {
  it("the whole path to a file below the top level, at every depth", () => {
    expect(nestedFileFieldsOf(TopDto)).toEqual(["mid.inner.file"]);
    expect(nestedFileFieldsOf(MidDto)).toEqual(["inner.file"]);
    expect(nestedFileFieldsOf(InnerDto)).toEqual([]);
    expect(nestedFileFieldsOf(PlainDto)).toEqual([]);
  });

  it("a cycle ends the search, and the top DTO's own file is no nested one", () => {
    expect(nestedFileFieldsOf(CycleTopDto)).toEqual(["mid.file"]);
    expect(nestedFileFieldsOf(DeepTopDto)).toEqual(["mid.inner.file"]);
  });
});
