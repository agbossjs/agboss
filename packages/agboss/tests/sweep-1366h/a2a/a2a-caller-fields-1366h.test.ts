/**
 * #1366: only a resolution the builders made counts as an authentication result (a look-alike object
 * does not), and `withoutFileFields` keeps every other schema keyword, drops only the file fields
 * and their `required`, hands an unchanged schema back when there are no file fields, and reads
 * a malformed `properties` (an array, a string, null) as no properties.
 */
import { describe, expect, it } from "vitest";
import { isHttpAuthResult } from "../../../src/http/http-auth.js";
import { withoutFileFields } from "../../../src/a2a/a2a-card-file-fields.js";
import type { JsonSchema } from "../../../src/dto/schema.js";
import { HttpAuthResult } from "../../../src/index.js";

describe("#1366 isHttpAuthResult", () => {
  it("is true for each builder's answer and false for look-alikes and non-objects", () => {
    expect(isHttpAuthResult(HttpAuthResult.forbidden("no"))).toBe(true);
    expect(isHttpAuthResult(HttpAuthResult.unauthenticated("no"))).toBe(true);
    expect(isHttpAuthResult({ kind: "forbidden", reason: "no" })).toBe(false);
    expect(isHttpAuthResult({})).toBe(false);
    expect(isHttpAuthResult([])).toBe(false);
    expect(isHttpAuthResult(null)).toBe(false);
    expect(isHttpAuthResult("forbidden")).toBe(false);
    expect(isHttpAuthResult(undefined)).toBe(false);
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
    const out = withoutFileFields(only, new Set(["doc"]), (name) => ({ "x-m": name }));
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
