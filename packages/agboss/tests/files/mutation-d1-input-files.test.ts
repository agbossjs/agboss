/**
 * #1269 (mutation shard files-pii): the files an agent's input holds — `filesOfValue` for one value of a
 * DTO and `inputFilesOf` for a node's fields: single fields, lists, `listOf(oneOf(…))`, pass-through.
 */
import { describe, expect, it } from "vitest";
import { A2AFileDto } from "../../src/a2a/files/a2a-file.dto.js";
import { ListOf, Nested, Text } from "../../src/dto/index.js";
import type { ResolvedField } from "../../src/flow/analyse/fields.js";
import { slotOfField } from "../../src/flow/analyse/scope.js";
import type { InputFieldShape } from "../../src/flow/decorators/declaration.js";
import { listOf, oneOf, optional } from "../../src/flow/dto-wrappers.js";
import type { ScopeRecords, ScopeValueRecord } from "../../src/flow/runtime/records.js";
import { filesOfValue, inputFilesOf } from "../../src/files/input-files.js";

class ParcelDto {
  @Nested(A2AFileDto, { prompt: "the cover" })
  cover!: A2AFileDto;

  @ListOf(A2AFileDto, { prompt: "pages", optional: true })
  pages?: A2AFileDto[];

  @Text({ prompt: "a note", optional: true })
  note?: string;
}

class SpecialFileDto extends A2AFileDto {}

class LetterDto {
  @Nested(A2AFileDto, { prompt: "the scan" })
  scan!: A2AFileDto;
}

const file = (id: string): A2AFileDto => ({ mediaType: "image/png", fileId: id });
const [a, b, c, d] = [file("a"), file("b"), file("c"), file("d")];

describe("filesOfValue: one value of a DTO", () => {
  it("a value of the file DTO is its own descriptor, shown under the field", () => {
    expect(filesOfValue(A2AFileDto, a, "doc")).toEqual([{ descriptor: a, field: "doc" }]);
    expect(filesOfValue(A2AFileDto, { nope: 1 }, "doc")).toEqual([]);
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
    const field = fieldOf("doc", A2AFileDto);

    expect(inputFilesOf([field], scopeOf(recordOf(field, a)))).toEqual([
      { descriptor: a, field: "doc", producer: "maker" },
    ]);
  });

  it("a DTO field's files are sources in declaration order across fields", () => {
    const parcel = fieldOf("parcel", ParcelDto);
    const doc = fieldOf("doc", A2AFileDto);

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
    const missing = fieldOf("missing", A2AFileDto);
    const passed = fieldOf("passed", LetterDto, true);
    const held = fieldOf("held", LetterDto);

    const found = inputFilesOf(
      [missing, passed, held],
      scopeOf(recordOf(passed, { scan: a }), recordOf(held, { scan: b })),
    );

    expect(found.map((one) => one.descriptor)).toEqual([b]);
  });

  it("a pass-through field whose value is a file is not read either", () => {
    const passed = fieldOf("passed", A2AFileDto, true);

    expect(inputFilesOf([passed], scopeOf(recordOf(passed, a)))).toEqual([]);
  });

  it("an optional field is read through its wrapper", () => {
    const field = fieldOf("doc", optional(A2AFileDto));

    expect(field.isRequired).toBe(false);
    expect(inputFilesOf([field], scopeOf(recordOf(field, a)))).toEqual([
      { descriptor: a, field: "doc", producer: "maker" },
    ]);
  });
});

describe("inputFilesOf: lists", () => {
  it("a list of files gives each element, its own producer when a join gathered several", () => {
    const field = fieldOf("pages", listOf(A2AFileDto));
    const record = recordOf(field, [a, b, c], { elementProducers: ["x", "y"] });

    expect(inputFilesOf([field], scopeOf(record))).toEqual([
      { descriptor: a, field: "pages", producer: "x" },
      { descriptor: b, field: "pages", producer: "y" },
      { descriptor: c, field: "pages", producer: "maker" },
    ]);
  });

  it("a plain list's element that looks like a variant is the value itself, not unwrapped", () => {
    const field = fieldOf("pages", listOf(A2AFileDto));
    const looksLikeVariant = { variant: "A2AFileDto", value: a };

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

describe("inputFilesOf: listOf(oneOf(…))", () => {
  const field = fieldOf("mixed", listOf(oneOf(A2AFileDto, LetterDto)));

  it("its slot is the polymorphic list's", () => {
    expect(field.slot.startsWith("list:oneOf(")).toBe(true);
  });

  it("each element is read as the class its variant names", () => {
    const record = recordOf(
      field,
      [
        { variant: "A2AFileDto", value: a },
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
      { variant: "A2AFileDto" },
      { value: a },
      { variant: "A2AFileDto", value: c },
    ]);

    expect(inputFilesOf([field], scopeOf(record)).map((one) => one.descriptor)).toEqual([c]);
  });

  it("a variant element needs its value: the key counts, not its content", () => {
    const record = recordOf(field, [{ variant: "A2AFileDto", value: undefined }]);

    expect(inputFilesOf([field], scopeOf(record))).toEqual([]);
  });
});
