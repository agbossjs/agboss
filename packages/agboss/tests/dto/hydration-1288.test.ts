/**
 * #1288a: a validated or restored DTO value is an instance of its class by prototype — never a
 * `new XDto()` on the hot path, never frozen — and every walk that masks, scrubs or fingerprints a
 * value treats a hydrated DTO like the plain object it is.
 */
import { describe, expect, it } from "vitest";
import { isDtoOrPlainObject } from "../../src/dto/plain.js";
import { hydrated } from "../../src/dto/hydrate.js";
import { Integer, List, Nested, Text, maskDto, validate } from "../../src/dto/index.js";
import { PiiAction } from "../../src/pii/actions.js";
import { mappedStrings } from "../../src/pii/strings.js";
import { observabilityMaskOf } from "../../src/pii/observability-mask.js";
import { PiiPolicySet } from "../../src/pii/policy-set.js";
import { stableJson } from "../../src/turns/versions.js";
import { redactedFilesIn } from "../../src/a2a/files/a2a-file-scrub.js";
import { FileDto } from "../../src/dto/standard/file.js";

class LineDto {
  @Text() sku!: string;
  @Integer() quantity!: number;
}

class OrderDto {
  @Text({ sensitive: PiiAction.mask() }) customer!: string;
  @Nested(LineDto) first!: LineDto;
  @List(LineDto) lines!: LineDto[];
}

const RAW = {
  customer: "Ada Lovelace",
  first: { sku: "A-1", quantity: 2 },
  lines: [{ sku: "B-2", quantity: 1 }],
};

describe("#1288a: prototype hydration", () => {
  it("validate returns an instance of the class, nested and listed ones included", () => {
    const order = validate(OrderDto, RAW);

    expect(order).toBeInstanceOf(OrderDto);
    expect(order.first).toBeInstanceOf(LineDto);
    expect(order.lines[0]).toBeInstanceOf(LineDto);
    expect(order.constructor).toBe(OrderDto);
    expect(order).toEqual(RAW);
  });

  it("does not freeze anything (D8) and calls no constructor of its own", () => {
    const order = validate(OrderDto, RAW);

    expect(Object.isFrozen(order)).toBe(false);
    expect(Object.isFrozen(order.first)).toBe(false);
    expect(Object.isFrozen(order.lines)).toBe(false);
  });

  it("hydrated() gives a plain restored value its classes, and keeps one that already has them", () => {
    const restored = hydrated(OrderDto, JSON.parse(JSON.stringify(RAW))) as OrderDto;

    expect(restored).toBeInstanceOf(OrderDto);
    expect(restored.first).toBeInstanceOf(LineDto);
    expect(restored.lines[0]).toBeInstanceOf(LineDto);
    expect(hydrated(OrderDto, restored)).toBe(restored);
    expect(hydrated(OrderDto, null)).toBeNull();
    expect(hydrated(OrderDto, "text")).toBe("text");
  });

  it("stableJson of a hydrated value is the one of the plain value", () => {
    expect(stableJson(validate(OrderDto, RAW))).toBe(stableJson(RAW));
    expect(stableJson(hydrated(OrderDto, RAW))).toBe(stableJson(RAW));
  });
});

describe("#1288a: isDtoOrPlainObject", () => {
  it("is true for plain objects, null-prototype ones and hydrated DTOs", () => {
    validate(LineDto, { sku: "x", quantity: 1 });

    expect(isDtoOrPlainObject({})).toBe(true);
    expect(isDtoOrPlainObject(Object.create(null))).toBe(true);
    expect(isDtoOrPlainObject(validate(LineDto, { sku: "x", quantity: 1 }))).toBe(true);
  });

  it("is false for Date, Error, RegExp, typed arrays, arrays, Map and primitives", () => {
    for (const value of [
      new Date(),
      new Error("x"),
      /x/,
      new Uint8Array(1),
      [],
      new Map(),
      1,
      "s",
      null,
    ])
      expect(isDtoOrPlainObject(value)).toBe(false);
  });

  it("an own constructor property never makes a value a DTO", () => {
    expect(isDtoOrPlainObject({ constructor: LineDto })).toBe(true);
    expect(isDtoOrPlainObject(Object.assign(new Date(), { constructor: LineDto }))).toBe(false);
  });
});

describe("#1288a: walks keep working on a hydrated DTO", () => {
  it("maskDto masks the sensitive field of a hydrated value and keeps its prototype", () => {
    const order = validate(OrderDto, RAW);
    const shown = maskDto(OrderDto, order);

    expect(JSON.stringify(shown)).not.toContain("Ada");
    expect(Object.getPrototypeOf(shown)).toBe(OrderDto.prototype);
  });

  it("mappedStrings walks a hydrated DTO and returns an instance of its class", () => {
    const mapped = mappedStrings(validate(OrderDto, RAW), (text) => text.toUpperCase()) as OrderDto;

    expect(mapped).toBeInstanceOf(OrderDto);
    expect(mapped.customer).toBe("ADA LOVELACE");
    expect(mapped.lines[0]?.sku).toBe("B-2");
  });

  it("mappedStrings leaves a Date as it is", () => {
    const when = new Date(0);

    expect(mappedStrings({ when }, (text) => text + "!")).toEqual({ when });
  });

  it("a hydrated FileDto is still found as a file descriptor and its bytes scrubbed", () => {
    const file = validate(FileDto, {
      mediaType: "text/plain",
      inline: "aGk=",
      sizeBytes: 2,
      sha256: "0".repeat(64),
    });
    const shown = redactedFilesIn({ file });

    expect(JSON.stringify(shown)).not.toContain("aGk=");
  });

  it("the observability mask keeps a Date timestamp as it is", async () => {
    const mask = observabilityMaskOf(new PiiPolicySet([], "k"));
    const when = new Date(0);

    await expect(mask.value({ at: when })).resolves.toEqual({ at: when });
  });
});
