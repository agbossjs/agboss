import { describe, expect, it } from "vitest";
import { Text } from "../../../src/dto/index.js";
import { listOf, oneOf, optional } from "../../../src/flow/dto-wrappers.js";
import { ImportTable } from "../../../src/flow/types/imports.js";
import { ClassLocator } from "../../../src/flow/types/locate.js";
import { trackedText, propertyName, valueText } from "../../../src/flow/types/shapes.js";

/** How shapes are written as types (#270 → wrappers, `Tracked<T, P>`). */

class ScoreDto {
  @Text({ prompt: "a score" })
  text!: string;
}
class RejectedDto {
  @Text({ prompt: "why" })
  text!: string;
}

const names = (): ImportTable =>
  new ImportTable(
    new ClassLocator([{ file: "/project/dtos.ts", exports: { RejectedDto, ScoreDto } }]),
    "/project/.agboss/types.d.ts",
  );

describe("#270: wrappers as types", () => {
  it("lists, oneOf, optional", () => {
    const table = names();

    expect(valueText(listOf(ScoreDto, RejectedDto), table)).toBe(
      "readonly (RejectedDto | ScoreDto)[]",
    );
    expect(valueText(oneOf(ScoreDto, RejectedDto), table)).toBe("RejectedDto | ScoreDto");
    expect(valueText(optional(listOf(ScoreDto)), table)).toBe("readonly ScoreDto[] | undefined");
  });

  it("a list field of oneOf values is an array of Tracked elements of the union", () => {
    expect(trackedText(optional(listOf(ScoreDto, RejectedDto)), "typeof X", names())).toBe(
      "readonly Tracked<RejectedDto | ScoreDto, typeof X>[]",
    );
  });

  it("a field name that is not an identifier is quoted", () => {
    expect([propertyName("draft"), propertyName("first-draft")]).toEqual([
      "draft",
      '"first-draft"',
    ]);
  });
});
