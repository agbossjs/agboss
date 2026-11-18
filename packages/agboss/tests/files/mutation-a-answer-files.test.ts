/** #1269: the answer-files module's promises, pinned value by value. */
import { describe, expect, it } from "vitest";
import { A2AFileDto, redactedFileOf } from "../../src/a2a/files/a2a-file.dto.js";
import { ListOf, Nested, Text } from "../../src/dto/index.js";
import type { JsonSchema } from "../../src/dto/schema.js";
import {
  answerFilesOf,
  mapFileFields,
  modelWrittenFileProblem,
  pickingMapper,
  seenPicker,
  shownAnswerOf,
  withPickedFiles,
  type AnswerFileCheck,
  type FilePick,
} from "../../src/files/answer-files.js";
import type { SeenFile } from "../../src/files/visit-files.js";

class PickedDto {
  @Nested(A2AFileDto, { prompt: "the file" })
  file!: A2AFileDto;

  @Text({ prompt: "a note", optional: true })
  note?: string;
}

class SubFileDto extends A2AFileDto {}

class SubPickedDto {
  @Nested(SubFileDto, { prompt: "the file" })
  file!: SubFileDto;
}

class ManyDto {
  @ListOf(A2AFileDto, { prompt: "the files" })
  files!: A2AFileDto[];

  @ListOf(Text, { prompt: "tags", optional: true })
  tags?: string[];
}

class InnerDto {
  @Nested(A2AFileDto, { prompt: "the inner file" })
  file!: A2AFileDto;
}

class OuterDto {
  @Nested(InnerDto, { prompt: "the inner" })
  inner!: InnerDto;

  @ListOf(InnerDto, { prompt: "the inners", optional: true })
  inners?: InnerDto[];
}

class PlainDto {
  @Text({ prompt: "a note" })
  note!: string;
}

class WithPlainDto {
  @Nested(PlainDto, { prompt: "plain" })
  plain!: PlainDto;

  @ListOf(PlainDto, { prompt: "plains", optional: true })
  plains?: PlainDto[];

  @Nested(A2AFileDto, { prompt: "the file" })
  file!: A2AFileDto;
}

/** The same shape as `A2AFileDto`, as a plain object (a class instance cannot be spread). */
interface FileShape {
  readonly mediaType: string;
  readonly filename?: string;
  readonly inline?: string;
  readonly sha256?: string;
}

const file = (name: string): FileShape => ({
  mediaType: "image/png",
  filename: name,
  inline: "AAAA",
});

const tag = (given: unknown): unknown => ({ tagged: given });

describe("mapFileFields", () => {
  it("replaces a file where it sits and leaves the other fields", () => {
    const given = { file: file("a.png"), note: "n" };

    expect(mapFileFields(PickedDto, given, tag)).toEqual({
      file: { tagged: file("a.png") },
      note: "n",
    });
  });

  it("treats a subclass of the file DTO as a file", () => {
    const given = { file: file("a.png") };

    expect(mapFileFields(SubPickedDto, given, tag)).toEqual({ file: { tagged: file("a.png") } });
  });

  it("goes through a nested DTO and a list of them, mapping the file and not the DTO", () => {
    const given = {
      inner: { file: file("1.png") },
      inners: [{ file: file("2.png") }, { file: file("3.png") }],
    };

    expect(mapFileFields(OuterDto, given, tag)).toEqual({
      inner: { file: { tagged: file("1.png") } },
      inners: [{ file: { tagged: file("2.png") } }, { file: { tagged: file("3.png") } }],
    });
  });

  it("does not touch a list of plain values beside the files", () => {
    const given = { files: [file("a.png")], tags: ["x", "y"] };

    expect(mapFileFields(ManyDto, given, tag)).toEqual({
      files: [{ tagged: file("a.png") }],
      tags: ["x", "y"],
    });
  });

  it("leaves a list field that is not a list as it is", () => {
    const given = { files: "not a list" };

    expect(mapFileFields(ManyDto, given, tag)).toEqual({ files: "not a list" });
  });

  it("returns what is not a record as it is", () => {
    const list: unknown[] = [];

    expect(mapFileFields(PickedDto, null, tag)).toBeNull();
    expect(mapFileFields(PickedDto, "text", tag)).toBe("text");
    expect(mapFileFields(PickedDto, 7, tag)).toBe(7);
    expect(mapFileFields(PickedDto, list, tag)).toBe(list);
    expect(mapFileFields(PickedDto, undefined, tag)).toBeUndefined();
  });

  it("returns a value of a DTO with no file in it as the same value", () => {
    const given = { note: "n" };

    expect(mapFileFields(PlainDto, given, tag)).toBe(given);
  });

  it("does not map a missing or a null file", () => {
    const seen: unknown[] = [];
    const record = (given: unknown): unknown => {
      seen.push(given);
      return given;
    };

    expect(mapFileFields(PickedDto, { file: null }, record)).toEqual({ file: null });
    expect(mapFileFields(PickedDto, { note: "n" }, record)).toEqual({ note: "n" });
    expect(seen).toEqual([]);
  });

  it("does not map the DTOs beside a file that hold no file", () => {
    const given = { plain: { note: "a" }, plains: [{ note: "b" }], file: file("a.png") };

    expect(mapFileFields(WithPlainDto, given, tag)).toEqual({
      plain: { note: "a" },
      plains: [{ note: "b" }],
      file: { tagged: file("a.png") },
    });
  });
});

describe("answerFilesOf and shownAnswerOf", () => {
  it("lists the descriptors in field order and only descriptors", () => {
    const given = {
      inner: { file: file("1.png") },
      inners: [{ file: file("2.png") }, { file: "junk" }],
    };

    expect(answerFilesOf(OuterDto, given)).toEqual([file("1.png"), file("2.png")]);
  });

  it("lists nothing for a value that holds no descriptor", () => {
    expect(answerFilesOf(PickedDto, { file: { file: 1 } })).toEqual([]);
  });

  it("shows each file as redactedFileOf shows it, never its bytes", () => {
    const given = { file: file("a.png"), note: "n" };

    const shown = shownAnswerOf(PickedDto, given);

    expect(shown).toEqual({ file: redactedFileOf(file("a.png")), note: "n" });
    expect(JSON.stringify(shown)).not.toContain("AAAA");
  });

  it("shows what is not a descriptor as it is", () => {
    expect(shownAnswerOf(PickedDto, { file: { file: 1 } })).toEqual({ file: { file: 1 } });
  });
});

const seenFile = (descriptor: A2AFileDto, digest: string): SeenFile => ({
  source: { descriptor, field: "document", producer: "start" },
  digest,
});

const problemOf = (pick: FilePick): string => (pick.kind === "problem" ? pick.problem : "a file");

describe("seenPicker", () => {
  const seen = [seenFile(file("a.png"), "d1"), seenFile(file("b.png"), "d2")];

  it("says which numbers exist when the number is past the end or below the first", () => {
    const picker = seenPicker(seen, true);

    expect(problemOf(picker.pick(3))).toBe(
      "there is no file 3: the files you were shown are numbered 1 to 2",
    );
    expect(problemOf(picker.pick(0))).toBe(
      "there is no file 0: the files you were shown are numbered 1 to 2",
    );
    expect(problemOf(seenPicker([], true).pick(1))).toBe(
      "there is no file 1: the files you were shown are numbered 1 to 0",
    );
  });

  it("refuses a file seen only as a transcription, saying so", () => {
    expect(problemOf(seenPicker(seen, false).pick(2))).toBe(
      "file 2 was shown to you only as a transcription, so it cannot be returned",
    );
  });

  it("hands on the descriptor with the digest of the bytes it was read as, when it had none", () => {
    const picked = seenPicker(seen, true).pick(2);

    expect(picked).toEqual({ kind: "file", file: { ...file("b.png"), sha256: "d2" } });
    expect(seen[1]?.source.descriptor).toEqual(file("b.png"));
  });

  it("hands on a descriptor that has a digest as it is", () => {
    const digested: FileShape = { ...file("c.png"), sha256: "a".repeat(64) };

    const picked = seenPicker([seenFile(digested, "other")], true).pick(1);

    expect(picked.kind === "file" ? picked.file : undefined).toBe(digested);
  });
});

describe("pickingMapper", () => {
  const picker = seenPicker([seenFile(file("a.png"), "d1")], true);
  const NOT_A_PICK =
    'a file in the answer is given as { "file": <number> } — the number of one of the files you were shown';

  it("turns { file: n } into the descriptor", () => {
    expect(pickingMapper(picker)({ file: 1 })).toEqual({ ...file("a.png"), sha256: "d1" });
  });

  it("refuses what is not a record, naming the form", () => {
    const map = pickingMapper(picker);

    expect(() => map("1")).toThrow(NOT_A_PICK);
    expect(() => map(null)).toThrow(NOT_A_PICK);
    expect(() => map(1)).toThrow(NOT_A_PICK);
    expect(() => map([1])).toThrow(NOT_A_PICK);
  });

  it("refuses a record that is not exactly { file: <integer >= 1> }", () => {
    const map = pickingMapper(picker);
    const inherited = Object.assign(Object.create({ file: 1 }) as object, { other: 2 });

    expect(() => map({ file: 1, extra: 2 })).toThrow(NOT_A_PICK);
    expect(() => map({ file: 0 })).toThrow(NOT_A_PICK);
    expect(() => map({ file: -1 })).toThrow(NOT_A_PICK);
    expect(() => map({ file: 1.5 })).toThrow(NOT_A_PICK);
    expect(() => map({ file: "1" })).toThrow(NOT_A_PICK);
    expect(() => map({})).toThrow(NOT_A_PICK);
    expect(() => map(inherited)).toThrow(NOT_A_PICK);
  });

  it("throws the picker's problem, in its words", () => {
    expect(() => pickingMapper(picker)({ file: 4 })).toThrow(
      "there is no file 4: the files you were shown are numbered 1 to 1",
    );
  });
});

const PICK = {
  type: "object",
  properties: {
    file: {
      type: "integer",
      minimum: 1,
      description:
        "the number of the file, as in the headings of the files you were shown (file 3 of 5)",
    },
  },
  required: ["file"],
  additionalProperties: false,
};

const schemaOf = (properties: Record<string, unknown>): JsonSchema => ({
  type: "object",
  properties,
  required: [],
});

const propertiesOf = (schema: JsonSchema): Record<string, unknown> => {
  const { properties } = schema;
  return typeof properties === "object" && properties !== null
    ? Object.fromEntries(Object.entries(properties))
    : {};
};

describe("withPickedFiles", () => {
  it("replaces a file's schema with the pick, keeping the field's description, and the rest as it is", () => {
    const note = { type: "string", description: "a note" };
    const schema = schemaOf({
      file: { type: "object", description: "the file" },
      note,
    });

    const picked = withPickedFiles(PickedDto, schema);

    expect(picked).toStrictEqual({
      type: "object",
      required: [],
      properties: { file: { ...PICK, description: "the file" }, note },
    });
  });

  it("gives a file with no description the pick's own", () => {
    const picked = withPickedFiles(PickedDto, schemaOf({ file: { type: "object" } }));

    expect(propertiesOf(picked).file).toStrictEqual(PICK);
  });

  it("replaces the items of a list of files, keeping the list's own keys", () => {
    const items = { type: "object", description: "one file" };
    const list = { type: "array", minItems: 1, description: "the files", items };

    const picked = withPickedFiles(ManyDto, schemaOf({ files: list, tags: { type: "array" } }));

    expect(propertiesOf(picked)).toStrictEqual({
      files: { ...list, items: { ...PICK, description: "one file" } },
      tags: { type: "array" },
    });
  });

  it("goes down through a nested DTO and a list of them", () => {
    const innerSchema = schemaOf({ file: { type: "object", description: "inner file" } });
    const outer = schemaOf({
      inner: { ...innerSchema, description: "the inner" },
      inners: { type: "array", items: innerSchema },
    });

    const picked = propertiesOf(withPickedFiles(OuterDto, outer));

    const replaced = {
      ...innerSchema,
      properties: { file: { ...PICK, description: "inner file" } },
    };
    expect(picked).toStrictEqual({
      inner: { ...replaced, description: "the inner" },
      inners: { type: "array", items: replaced },
    });
  });

  it("returns the same schema where there is no file or no properties to look in", () => {
    const plain = schemaOf({ note: { type: "string" } });
    const bare: JsonSchema = { type: "object" };
    const listed: JsonSchema = { type: "object", properties: [] };

    expect(withPickedFiles(PlainDto, plain)).toBe(plain);
    expect(withPickedFiles(PickedDto, bare)).toBe(bare);
    expect(withPickedFiles(PickedDto, listed)).toBe(listed);
  });

  it("leaves DTOs with no file beside the files as they are", () => {
    const plainSchema = schemaOf({ note: { type: "string" } });
    const plains = { type: "array", items: plainSchema };
    const schema = schemaOf({
      plain: plainSchema,
      plains,
      file: { type: "object" },
    });

    const picked = propertiesOf(withPickedFiles(WithPlainDto, schema));

    expect(picked.plain).toBe(plainSchema);
    expect(picked.plains).toBe(plains);
    expect(picked.file).toStrictEqual(PICK);
  });

  it("does not fail on a field whose schema is missing, nor on a list of plain values", () => {
    const picked = withPickedFiles(ManyDto, schemaOf({ tags: { type: "array" } }));
    const nested = withPickedFiles(OuterDto, schemaOf({}));

    expect(propertiesOf(picked)).toStrictEqual({ files: undefined, tags: { type: "array" } });
    expect(propertiesOf(nested)).toStrictEqual({ inner: undefined, inners: undefined });
  });
});

const check = (over: Partial<AnswerFileCheck> = {}): AnswerFileCheck => ({
  allowedOrigins: ["https://ok.example"],
  store: { findMetadata: () => Promise.resolve(undefined) },
  tenantId: "t",
  ownerId: "root",
  ...over,
});

const urlFile = (url: string): A2AFileDto => ({ mediaType: "image/png", url });

describe("modelWrittenFileProblem", () => {
  it("allows an https url on an allowed origin", async () => {
    expect(await modelWrittenFileProblem([urlFile("https://ok.example/a.png")], check())).toBe(
      undefined,
    );
  });

  it("names the file by its place, and why, for each way a url is not allowed", async () => {
    const problem = (
      url: string,
      place: readonly A2AFileDto[] = [urlFile(url)],
    ): Promise<unknown> => modelWrittenFileProblem(place, check());

    expect(await problem("not a url")).toBe(
      "answer file 1 of 1 is not allowed: its url is not a URL",
    );
    expect(await problem("http://ok.example/a.png")).toBe(
      "answer file 1 of 1 is not allowed: its url is not https:",
    );
    expect(await problem("https://other.example/a.png")).toBe(
      "answer file 1 of 1 is not allowed: its url's origin is not allowed",
    );
    const two = [urlFile("https://ok.example/a.png"), urlFile("https://other.example/a.png")];
    expect(await problem("", two)).toBe(
      "answer file 2 of 2 is not allowed: its url's origin is not allowed",
    );
  });

  it("refuses a url with a user, with a password, or with both", async () => {
    const message = "answer file 1 of 1 is not allowed: its url carries a user or a password";

    for (const url of [
      "https://user@ok.example/a.png",
      "https://:secret@ok.example/a.png",
      "https://user:secret@ok.example/a.png",
    ])
      expect(await modelWrittenFileProblem([urlFile(url)], check())).toBe(message);
  });

  it("refuses a stored file the root execution does not own, and a missing one", async () => {
    const stored: A2AFileDto = { mediaType: "image/png", fileId: "f1" };
    const holding = (ownerId: string): AnswerFileCheck["store"] => ({
      findMetadata: () =>
        Promise.resolve({
          tenantId: "t",
          fileId: "f1",
          ownerId,
          mediaType: "image/png",
          sha256: "a".repeat(64),
          sizeBytes: 3,
          createdAt: new Date(0),
        }),
    });
    const owned = holding("root");
    const foreign = holding("other");

    expect(await modelWrittenFileProblem([stored], check({ store: owned }))).toBe(undefined);
    expect(await modelWrittenFileProblem([stored], check({ store: foreign }))).toBe(
      "answer file 1 of 1 is not allowed: it is not one this execution holds",
    );
    expect(await modelWrittenFileProblem([stored], check())).toBe(
      "answer file 1 of 1 is not allowed: it is not one this execution holds",
    );
  });
});
