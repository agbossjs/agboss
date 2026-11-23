/**
 * #1366: how the client reads the file fields a card declares and compares them with its DTOs:
 * only boolean flags count, a malformed declaration is no declaration, a bare `true` marker is a
 * field of unknown shape (nothing is compared against the unknown), an undeclared input file field,
 * a required file field the client lacks, a list/one-file or optional/required clash on either
 * side is one difference naming the field, and the data compared apart from the file fields.
 */
import { describe, expect, it } from "vitest";
import {
  declaredFileFieldsOf,
  declaredOutputFileFieldsOf,
  fileFieldDifferencesOf,
  outputFileFieldDifferencesOf,
  type DeclaredFileFields,
} from "../../../src/a2a/client/a2a-card-files.js";
import { schemaDifferencesOf, skillSchemasOf } from "../../../src/a2a/client/a2a-card-schemas.js";
import { FILE_PART_KEYWORD } from "../../../src/a2a/a2a-card-file-fields.js";
import { A2AFileDto } from "../../../src/a2a/files/a2a-file.dto.js";
import { ListOf, Nested, Text } from "../../../src/dto/index.js";
import { jsonSchemaOf } from "../../../src/dto/schema.js";

class OneRequired {
  @Nested(A2AFileDto, { prompt: "doc" })
  doc!: A2AFileDto;
}
class OneOptional {
  @Nested(A2AFileDto, { prompt: "doc", optional: true })
  doc?: A2AFileDto;
}
class ManyRequired {
  @ListOf(A2AFileDto, { prompt: "doc" })
  doc!: A2AFileDto[];
}
class NoFiles {
  @Text({ prompt: "note" })
  note!: string;
}
class FileAndNote {
  @Nested(A2AFileDto, { prompt: "doc" })
  doc!: A2AFileDto;
  @Text({ prompt: "note" })
  note!: string;
}
class NoteAsText {
  @Text({ prompt: "doc" })
  doc!: string;
}

const declared = (entries: Record<string, { list?: boolean; optional?: boolean }>) =>
  new Map(
    Object.entries(entries).map(([name, field]) => [
      name,
      { list: field.list, optional: field.optional },
    ]),
  ) as DeclaredFileFields;

describe("#1366 reading the declarations", () => {
  it("files: only boolean flags count, only record fields are fields", () => {
    const found = declaredFileFieldsOf({
      files: {
        a: { list: true, optional: false },
        b: { list: "yes", optional: 1 },
        c: "x",
        d: null,
        e: [],
      },
    });
    expect([...found.keys()]).toEqual(["a", "b"]);
    expect(found.get("a")).toStrictEqual({ list: true, optional: false });
    expect(found.get("b")).toStrictEqual({ list: undefined, optional: undefined });
  });

  it("markers in the input schema: a bare true is unknown, an object is a declaration, else none", () => {
    const found = declaredFileFieldsOf({
      input: {
        properties: {
          a: { [FILE_PART_KEYWORD]: true },
          b: { [FILE_PART_KEYWORD]: { list: true, optional: true } },
          c: { [FILE_PART_KEYWORD]: false },
          d: { [FILE_PART_KEYWORD]: "x" },
          e: { type: "string" },
          f: "x",
        },
      },
    });
    expect([...found.keys()]).toEqual(["a", "b"]);
    expect(found.get("a")).toStrictEqual({ list: undefined, optional: undefined });
    expect(found.get("b")).toStrictEqual({ list: true, optional: true });
  });

  it("no files and no usable schema: no declared fields", () => {
    expect(declaredFileFieldsOf({ input: "x" }).size).toBe(0);
    expect(declaredFileFieldsOf({ input: { properties: [] } }).size).toBe(0);
    expect(declaredFileFieldsOf({}).size).toBe(0);
  });

  it("outputs read per finish: outputFiles first, else the markers of its schema", () => {
    const entry = {
      outputFiles: { done: { r: { list: false, optional: true } } },
      outputs: { other: { properties: { m: { [FILE_PART_KEYWORD]: { list: true } } } } },
    };
    expect(declaredOutputFileFieldsOf(entry, "done").get("r")).toStrictEqual({
      list: false,
      optional: true,
    });
    expect(declaredOutputFileFieldsOf(entry, "other").get("m")).toStrictEqual({
      list: true,
      optional: undefined,
    });
    expect(declaredOutputFileFieldsOf(entry, "none").size).toBe(0);
    expect(declaredOutputFileFieldsOf({ outputFiles: "x", outputs: 3 }, "done").size).toBe(0);
  });
});

describe("#1366 the client's input file fields against the declared ones", () => {
  const diffs = (input: Parameters<typeof fileFieldDifferencesOf>[0], map: DeclaredFileFields) =>
    fileFieldDifferencesOf(input, map);

  it("a file field the skill does not declare is one difference naming it", () => {
    const out = diffs(OneRequired, declared({}));
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("doc");
  });

  it("a declared field of the same shape: none", () => {
    expect(diffs(OneRequired, declared({ doc: { list: false, optional: false } }))).toEqual([]);
  });

  it("a field of unknown shape (a bare marker) is compared with nothing", () => {
    expect(diffs(OneRequired, declared({ doc: {} }))).toEqual([]);
    expect(diffs(ManyRequired, declared({ doc: {} }))).toEqual([]);
  });

  it("a list against one file, and one file against a list, is one difference each", () => {
    expect(diffs(ManyRequired, declared({ doc: { list: false } }))).toHaveLength(1);
    expect(diffs(OneRequired, declared({ doc: { list: true } }))).toHaveLength(1);
    expect(diffs(ManyRequired, declared({ doc: { list: true } }))).toEqual([]);
  });

  it("optional in the client but required on the skill is a difference; the rest are none", () => {
    expect(diffs(OneOptional, declared({ doc: { optional: false } }))).toHaveLength(1);
    expect(diffs(OneOptional, declared({ doc: { optional: true } }))).toEqual([]);
    expect(diffs(OneOptional, declared({ doc: {} }))).toEqual([]);
    expect(diffs(OneRequired, declared({ doc: { optional: false } }))).toEqual([]);
  });

  it("a required file the client lacks is one difference naming it; an optional or unknown one is none", () => {
    const out = diffs(NoFiles, declared({ doc: { optional: false } }));
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("doc");
    expect(diffs(NoFiles, declared({ doc: { optional: true } }))).toEqual([]);
    expect(diffs(NoFiles, declared({ doc: {} }))).toEqual([]);
  });
});

describe("#1366 the client's output file fields against a finish's", () => {
  const diffs = (
    output: Parameters<typeof outputFileFieldDifferencesOf>[0],
    map: DeclaredFileFields,
  ) => outputFileFieldDifferencesOf(output, map, "done");

  it("a required file the finish does not give is one difference naming it and the finish", () => {
    const out = diffs(OneRequired, declared({}));
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("doc");
    expect(out[0]).toContain("done");
  });

  it("an optional file the finish does not give is none", () => {
    expect(diffs(OneOptional, declared({}))).toEqual([]);
  });

  it("a field of unknown shape is compared with nothing; a clash of list is one difference", () => {
    expect(diffs(OneRequired, declared({ doc: {} }))).toEqual([]);
    expect(diffs(ManyRequired, declared({ doc: { list: false } }))).toHaveLength(1);
    expect(diffs(OneRequired, declared({ doc: { list: true } }))).toHaveLength(1);
    expect(diffs(OneRequired, declared({ doc: { list: false } }))).toEqual([]);
  });

  it("optional on the finish, required in the client's output, is one difference; the rest none", () => {
    expect(diffs(OneRequired, declared({ doc: { optional: true } }))).toHaveLength(1);
    expect(diffs(OneOptional, declared({ doc: { optional: true } }))).toEqual([]);
    expect(diffs(OneRequired, declared({ doc: { optional: false } }))).toEqual([]);
    expect(diffs(OneRequired, declared({ doc: {} }))).toEqual([]);
  });

  it("a field the finish gives as files but the client reads as data is one difference", () => {
    const out = diffs(NoteAsText, declared({ doc: {} }));
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("doc");
    expect(diffs(NoFiles, declared({ doc: {} }))).toEqual([]);
    expect(diffs(NoteAsText, declared({ other: {} }))).toEqual([]);
  });
});

describe("#1366 the data compared apart from the file fields", () => {
  const noteSchema = jsonSchemaOf(NoFiles);

  it("an input with a file field and data matches a card that declares the file apart", () => {
    const schemas = skillSchemasOf({
      input: { ...noteSchema, additionalProperties: false },
      files: { doc: { list: false, optional: false } },
    });
    expect(schemaDifferencesOf(schemas, { input: FileAndNote, output: undefined })).toEqual([]);
  });

  it("a data mismatch of the input is a difference starting with input:", () => {
    const schemas = skillSchemasOf({ input: noteSchema });
    const out = schemaDifferencesOf(schemas, { input: NoteAsNumber, output: undefined });
    expect(out.length).toBeGreaterThan(0);
    for (const each of out) expect(each.startsWith("input: ")).toBe(true);
  });

  it("a data mismatch of an output is a string difference of that finish", () => {
    const schemas = skillSchemasOf({ outputs: { done: noteSchema, other: noteSchema } });
    const out = schemaDifferencesOf(schemas, {
      input: undefined,
      output: NoteAsNumber,
      finishes: ["done"],
    });
    expect(out.length).toBeGreaterThan(0);
    for (const each of out) expect(each.startsWith("output (done): ")).toBe(true);
  });

  it("an output's file fields are compared with each finish's declared ones", () => {
    const schemas = skillSchemasOf({ outputs: { done: noteSchema }, outputFiles: { done: {} } });
    const out = schemaDifferencesOf(schemas, { input: undefined, output: OneRequired });
    expect(out.length).toBeGreaterThan(0);
    for (const each of out) expect(each.startsWith("output (done)")).toBe(true);
  });

  it("outputs that are not records are no finishes", () => {
    expect(Object.keys(skillSchemasOf({ outputs: { a: "x", b: noteSchema } }).outputs)).toEqual([
      "b",
    ]);
    expect(Object.keys(skillSchemasOf({ outputs: ["x"] }).outputs)).toEqual([]);
  });
});

class NoteAsNumber {
  @Text({ prompt: "note", optional: true })
  note?: string;

  @Text({ prompt: "extra" })
  extra!: string;
}
