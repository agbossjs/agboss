import { describe, expect, it } from "vitest";
import { incompatibilitiesOf } from "../../src/federation/schema-compat.js";

const object = (
  properties: Record<string, unknown>,
  required: readonly string[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({ type: "object", properties, required, ...extra });

describe("#398 PR 4: one JSON Schema accepts another, structurally", () => {
  it("equal shapes, a looser receiver, an integer into a number and an optional field are compatible", () => {
    const sender = object({ amount: { type: "integer", minimum: 1 }, note: { type: "string" } }, [
      "amount",
      "note",
    ]);
    const receiver = object(
      { amount: { type: "number", minimum: 0 }, note: { type: "string" }, tag: { type: "string" } },
      ["amount"],
    );

    expect(incompatibilitiesOf(receiver, sender)).toEqual([]);
  });

  it("names each difference by its field path", () => {
    const sender = object(
      {
        currency: { type: "string" },
        lines: { type: "array", items: object({ amount: { type: "string" } }, ["amount"]) },
        status: { enum: ["open", "paid", "void"] },
      },
      ["lines", "status"],
    );
    const receiver = object(
      {
        currency: { type: "string", minLength: 3 },
        lines: { type: "array", items: object({ amount: { type: "number" } }, ["amount"]) },
        status: { enum: ["open", "paid"] },
      },
      ["currency", "lines", "status"],
      { additionalProperties: false },
    );

    expect(incompatibilitiesOf(receiver, sender)).toEqual([
      'field "currency" is now required; the sender may leave it out',
      "currency must now be at least 3 (minLength)",
      "lines[].amount may be string; only number is accepted",
      'status may be ["void"], which is not accepted',
    ]);
  });

  it("follows $ref into $defs, reads unions and refuses a field the receiver closed", () => {
    const sender = {
      $defs: { Money: object({ cents: { type: "integer" } }, ["cents"]) },
      ...object({ total: { $ref: "#/$defs/Money" }, extra: { type: "string" } }, ["total"]),
    };
    const receiver = object(
      { total: { anyOf: [{ type: "string" }, object({ cents: { type: "number" } }, ["cents"])] } },
      ["total"],
      { additionalProperties: false },
    );

    expect(incompatibilitiesOf(receiver, sender)).toEqual(['field "extra" is no longer accepted']);
    expect(
      incompatibilitiesOf(receiver, object({ total: { type: "boolean" } }, ["total"])),
    ).toEqual(["total may be boolean; only string is accepted"]);
  });

  it("a field the sender does not have at all, and a sender that promises no type", () => {
    expect(incompatibilitiesOf(object({ id: { type: "string" } }, ["id"]), object({}, []))).toEqual(
      ['field "id" is now required; the sender does not send it'],
    );
    expect(incompatibilitiesOf({ type: "string", pattern: "^A" }, {})).toEqual([
      "the value may be of any type; only string is accepted",
      "the value must now match ^A",
    ]);
  });
});
