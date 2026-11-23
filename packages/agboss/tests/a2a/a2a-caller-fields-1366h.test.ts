/**
 * #1366: only a resolution the builders made counts as a caller resolution (a look-alike object
 * does not), and `withoutFileFields` keeps every other schema keyword, drops only the file fields
 * and their `required`, hands an unchanged schema back when there are no file fields, and reads
 * a malformed `properties` (an array, a string, null) as no properties.
 */
import { describe, expect, it } from "vitest";
import { A2ACallerResolution, isA2ACallerResolution } from "../../src/a2a/a2a-caller.js";
import { withoutFileFields } from "../../src/a2a/a2a-card-file-fields.js";
import type { JsonSchema } from "../../src/dto/schema.js";

describe("#1366 isA2ACallerResolution", () => {
  it("is true for each builder's answer and false for look-alikes and non-objects", () => {
    expect(isA2ACallerResolution(A2ACallerResolution.forbidden({ reason: "no" }))).toBe(true);
    expect(isA2ACallerResolution(A2ACallerResolution.unauthenticated({ reason: "no" }))).toBe(true);
    expect(isA2ACallerResolution({ kind: "forbidden", reason: "no" })).toBe(false);
    expect(isA2ACallerResolution({})).toBe(false);
    expect(isA2ACallerResolution([])).toBe(false);
    expect(isA2ACallerResolution(null)).toBe(false);
    expect(isA2ACallerResolution("forbidden")).toBe(false);
    expect(isA2ACallerResolution(undefined)).toBe(false);
  });
});

describe("#1366 withoutFileFields", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: { a: { type: "string" }, doc: { type: "string" } },
    required: ["a", "doc"],
  } as JsonSchema;

  it("without file fields hands the same schema back", () => {
    expect(withoutFileFields(schema, new Set())).toBe(schema);
  });

  it("drops the field and its required, keeps every other keyword", () => {
    expect(withoutFileFields(schema, new Set(["doc"]))).toEqual({
      type: "object",
      additionalProperties: false,
      properties: { a: { type: "string" } },
      required: ["a"],
    });
  });

  it("with a marker replaces the field's schema; no required key when none is left", () => {
    const only = { ...schema, required: ["doc"] } as JsonSchema;
    const out = withoutFileFields(
      only,
      new Set(["doc"]),
      (name) => ({ "x-m": name }),
    );
    expect(out).toEqual({
      type: "object",
      additionalProperties: false,
      properties: { a: { type: "string" }, doc: { "x-m": "doc" } },
    });
    expect("required" in out).toBe(false);
  });

  it.each([
    ["an array", [{ type: "string" }]],
    ["a string", "abc"],
    ["null", null],
    ["a number", 3],
  ])("properties as %s is read as none", (_name, properties) => {
    const out = withoutFileFields({ type: "object", properties }, new Set(["doc"]));
    expect(out).toEqual({ type: "object", properties: {} });
  });
});
