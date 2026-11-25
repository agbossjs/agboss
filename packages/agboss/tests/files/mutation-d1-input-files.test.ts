/**
 * #1269 (mutation shard files-pii): the files an agent's input holds — `filesOfValue` for one value of a
 * DTO and `inputFilesOf` for a node's fields: single fields, lists, `listOf(…)`, pass-through.
 */
import { describe, expect, it } from "vitest";
import { FileDto } from "../../src/dto/standard/file.js";
import { List, Nested, Text } from "../../src/dto/index.js";
import type { ResolvedField } from "../../src/flow/analyse/fields.js";
import { slotOfField } from "../../src/flow/analyse/scope.js";
import type { InputFieldShape } from "../../src/flow/decorators/declaration.js";
import { listOf, oneOf, optional } from "../../src/flow/dto-wrappers.js";
import type { ScopeRecords, ScopeValueRecord } from "../../src/flow/runtime/records.js";
import { filesOfValue, inputFilesOf } from "../../src/files/input-files.js";

class ParcelDto {
  @Nested(FileDto, { prompt: "the cover" })
  cover!: FileDto;

  @List(FileDto, { prompt: "pages", optional: true })
  pages?: FileDto[];

  @Text({ prompt: "a note", optional: true })
  note?: string;
}

class SpecialFileDto extends FileDto {}

class LetterDto {
  @Nested(FileDto, { prompt: "the scan" })
  scan!: FileDto;
}

const file = (id: string): FileDto => ({ mediaType: "image/png", fileId: id });
const [a, b, c, d] = [file("a"), file("b"), file("c"), file("d")];

describe("filesOfValue: one value of a DTO", () => {
  it("a value of the file DTO is its own descriptor, shown under the field", () => {
    expect(filesOfValue(FileDto, a, "doc")).toEqual([{ descriptor: a, field: "doc" }]);
    expect(filesOfValue(FileDto, { nope: 1 }, "doc")).toEqual([]);
  });

  it("a value of a DTO that extends the file DTO is one too", () => {
    expect(filesOfValue(SpecialFileDto, a, "doc")).toEqual([{ descriptor: a, field: "doc" }]);
  });

  it("a DTO with file fields gives each, a list's elements named by their field", () => {
    const value = { cover: a, pages: [b, { junk: 1 }, c], note: "hi" };

    expect(filesOfValue(ParcelDto, value, "parcel")).toEqual([
      { descriptor: a, field: "parcel.cover" },
      { descriptor: b, field: "parcel.pages" },
      { descriptor: c, field: "parcel.pages" },
    ]);
  });

  it("a value that is no record holds no files, and nothing throws", () => {
    for (const value of [undefined, null, "text", 7, true, []])
      expect(filesOfValue(ParcelDto, value, "parcel")).toEqual([]);
  });

  it("an absent optional list and a field that is no descriptor give none", () => {
    expect(filesOfValue(ParcelDto, { cover: "x" }, "p")).toEqual([]);
    expect(filesOfValue(ParcelDto, { cover: a }, "p")).toEqual([
      { descriptor: a, field: "p.cover" },
    ]);
  });
});

const fieldOf = (name: string, shape: InputFieldShape, isPassThrough = false): ResolvedField => ({
  name,
  label: name,
  shape,
  ...slotOfField(shape),
  isPassThrough,
});

const recordOf = (
  field: ResolvedField,
  value: unknown,
  rest: Partial<ScopeValueRecord> = {},
): ScopeValueRecord => ({
  valueId: `n:1/${field.slot}`,
  slot: field.slot,
  producer: "maker",
  value,
  builtFrom: [],
  ...rest,
});

const scopeOf = (...records: ScopeValueRecord[]): ScopeRecords =>
  Object.fromEntries(records.map((record) => [record.slot, record]));

describe("inputFilesOf: single fields", () => {
  it("a field holding a file is a source, its producer the value's producer", () => {
    const field = fieldOf("doc", FileDto);

    expect(inputFilesOf([field], scopeOf(recordOf(field, a)))).toEqual([
      { descriptor: a, field: "doc", producer: "maker" },
    ]);
  });

  it("a DTO field's files are sources in declaration order across fields", () => {
    const parcel = fieldOf("parcel", ParcelDto);
    const doc = fieldOf("doc", FileDto);

    const found = inputFilesOf(
      [parcel, doc],
      scopeOf(
        recordOf(parcel, { cover: a, pages: [b] }, { producer: "p1" }),
        recordOf(doc, c, { producer: "p2" }),
      ),
    );

    expect(found).toEqual([
      { descriptor: a, field: "parcel.cover", producer: "p1" },
      { descriptor: b, field: "parcel.pages", producer: "p1" },
      { descriptor: c, field: "doc", producer: "p2" },
    ]);
  });

  it("a field the scope has no value for, and a pass-through field, give no files", () => {
    const missing = fieldOf("missing", FileDto);
    const passed = fieldOf("passed", LetterDto, true);
    const held = fieldOf("held", LetterDto);

    const found = inputFilesOf(
      [missing, passed, held],
      scopeOf(recordOf(passed, { scan: a }), recordOf(held, { scan: b })),
    );

    expect(found.map((one) => one.descriptor)).toEqual([b]);
  });

  it("a pass-through field whose value is a file is not read either", () => {
    const passed = fieldOf("passed", FileDto, true);

    expect(inputFilesOf([passed], scopeOf(recordOf(passed, a)))).toEqual([]);
  });

  it("an optional field is read through its wrapper", () => {
    const field = fieldOf("doc", optional(FileDto));

    expect(field.isRequired).toBe(false);
    expect(inputFilesOf([field], scopeOf(recordOf(field, a)))).toEqual([
      { descriptor: a, field: "doc", producer: "maker" },
    ]);
  });
});

describe("inputFilesOf: lists", () => {
  it("a list of files gives each element, its own producer when a join gathered several", () => {
    const field = fieldOf("pages", listOf(FileDto));
    const record = recordOf(field, [a, b, c], { elementProducers: ["x", "y"] });

    expect(inputFilesOf([field], scopeOf(record))).toEqual([
      { descriptor: a, field: "pages", producer: "x" },
      { descriptor: b, field: "pages", producer: "y" },
      { descriptor: c, field: "pages", producer: "maker" },
    ]);
  });

  it("a plain list's element that looks like a variant is the value itself, not unwrapped", () => {
    const field = fieldOf("pages", listOf(FileDto));
    const looksLikeVariant = { variant: "FileDto", value: a };

    expect(inputFilesOf([field], scopeOf(recordOf(field, [looksLikeVariant, d])))).toEqual([
      { descriptor: d, field: "pages", producer: "maker" },
    ]);
  });

  it("a list of DTOs with file fields gives their files named by the list's field", () => {
    const field = fieldOf("letters", listOf(LetterDto));

    expect(inputFilesOf([field], scopeOf(recordOf(field, [{ scan: a }, { scan: b }])))).toEqual([
      { descriptor: a, field: "letters.scan", producer: "maker" },
      { descriptor: b, field: "letters.scan", producer: "maker" },
    ]);
  });
});

describe("inputFilesOf: listOf(…)", () => {
  const field = fieldOf("mixed", listOf(FileDto, LetterDto));

  it("its slot is the polymorphic list's", () => {
    expect(field.slot.startsWith("list:oneOf(")).toBe(true);
  });

  it("each element is read as the class its variant names", () => {
    const record = recordOf(
      field,
      [
        { variant: "FileDto", value: a },
        { variant: "LetterDto", value: { scan: b } },
      ],
      { elementProducers: ["p1", "p2"] },
    );

    expect(inputFilesOf([field], scopeOf(record))).toEqual([
      { descriptor: a, field: "mixed", producer: "p1" },
      { descriptor: b, field: "mixed.scan", producer: "p2" },
    ]);
  });

  it("an element of an unknown variant, or none, gives no files", () => {
    const record = recordOf(field, [
      { variant: "OtherDto", value: a },
      a,
      null,
      "text",
      { variant: 5, value: a },
      { variant: "FileDto" },
      { value: a },
      { variant: "FileDto", value: c },
    ]);

    expect(inputFilesOf([field], scopeOf(record)).map((one) => one.descriptor)).toEqual([c]);
  });

  it("a variant element needs its value: the key counts, not its content", () => {
    const record = recordOf(field, [{ variant: "FileDto", value: undefined }]);

    expect(inputFilesOf([field], scopeOf(record))).toEqual([]);
  });
});
