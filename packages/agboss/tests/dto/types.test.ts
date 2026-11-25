/**
 * #118 AC5 (narrowed, #113 correction 1): what the compiler checks on a DTO. `make check` runs `tsc`
 * over tests/: every `@ts-expect-error` below must stay an error, or the build fails.
 */
import { describe, expect, it } from "vitest";
import {
  CurrencyCode,
  IsoDate,
  Float,
  Email,
  Bool,
  Integer,
  List,
  Nested,
  Enum,
  Text,
} from "../../src/dto/index.js";
import { fieldsOf } from "../../src/dto/metadata.js";

class Issue {
  @Text({ prompt: "one line" })
  title!: string;
}

class Review {
  @Text({ prompt: "what changed", maxLength: 200 })
  summary!: string;

  @Integer({ optional: true, min: 0 })
  score?: number;

  @Float({ default: 0.5 })
  weight!: number;

  @Bool()
  approved!: boolean;

  @Enum(["file", "folder"])
  kind!: "file" | "folder";

  @List(Issue, { minItems: 1 })
  issues!: Issue[];

  @List(Text, { optional: true })
  tags?: string[];

  @Nested(Issue, { optional: true })
  main?: Issue;

  @IsoDate()
  day!: string;
}

/** Declared, never instantiated: only `tsc` looks at these. */
class Mistakes {
  // @ts-expect-error — @Text on a number
  @Text()
  count!: number;

  // @ts-expect-error — @Email on a boolean
  @Email()
  flag!: boolean;

  // @ts-expect-error — optional field without `optional: true`
  @Text()
  note?: string;

  // @ts-expect-error — `optional: true` on a required field
  @Text({ optional: true })
  name!: string;

  // @ts-expect-error — `values` misses "folder"
  @Enum(["file"])
  narrow!: "file" | "folder";

  // @ts-expect-error — `values` has "link", the field does not
  @Enum(["file", "folder", "link"])
  wide!: "file" | "folder";

  // @ts-expect-error — @Enum on a plain string
  @Enum(["file", "folder"])
  loose!: string;

  // @ts-expect-error — list of Issue on a single Issue
  @List(Issue)
  single!: Issue;

  // @ts-expect-error — list of text on a list of numbers
  @List(Text)
  numbers!: number[];

  // @ts-expect-error — nested DTO of another shape
  @Nested(Issue)
  other!: { id: number };

  // @ts-expect-error — a default of the wrong type
  @CurrencyCode({ default: 1 })
  currency!: string;

  // @ts-expect-error — a TS-private field is not plain data
  @Text()
  private hidden!: string;

  // @ts-expect-error — a static field is not data
  @Text()
  static shared: string;
}

describe("DTO field decorators — compile-time checks (#118)", () => {
  it("AC5: the file above type-checks only because each mistake is a compile error", () => {
    expect(fieldsOf(Review).map((field) => field.name)).toEqual([
      "summary",
      "score",
      "weight",
      "approved",
      "kind",
      "issues",
      "tags",
      "main",
      "day",
    ]);
    expect(Mistakes.name).toBe("Mistakes");
  });
});
