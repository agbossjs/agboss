import { describe, expect, it } from "vitest";
import {
  DtoValidationError,
  Integer,
  KeyText,
  MoneyDto,
  Nested,
  Text,
  Validate,
  jsonSchemaOf,
  maskDto,
  validate,
  type DtoIssue,
} from "../../src/dto/index.js";
import { PiiAction } from "../../src/pii/actions.js";

const issuesOf = (run: () => unknown): readonly DtoIssue[] => {
  try {
    run();
  } catch (error) {
    if (error instanceof DtoValidationError) return error.issues;
    throw error;
  }
  throw new Error("expected a validation failure");
};

@Validate<Range>(({ from, to }) => from <= to || "to is before from")
class Range {
  @Integer()
  from!: number;
  @Integer()
  to!: number;
}

@Validate<NarrowRange>(({ to }) => to < 100 || { field: "to", reason: "to must stay below 100" })
class NarrowRange extends Range {}

class Holder {
  @Nested(Range)
  range!: Range;
}

describe("#1292b: @Validate", () => {
  it("passes a valid value and fails with the author's text at the root", () => {
    expect(validate(Range, { from: 1, to: 2 })).toEqual({ from: 1, to: 2 });
    expect(issuesOf(() => validate(Range, { from: 3, to: 2 }))).toEqual([
      { path: "(root)", reason: "to is before from" },
    ]);
  });

  it("a subclass inherits the parent's checks and adds its own, parents first", () => {
    expect(issuesOf(() => validate(NarrowRange, { from: 3, to: 2 }))).toEqual([
      { path: "(root)", reason: "to is before from" },
    ]);
    expect(issuesOf(() => validate(NarrowRange, { from: 1, to: 100 }))).toEqual([
      { path: "to", reason: "to must stay below 100" },
    ]);
    expect(validate(NarrowRange, { from: 1, to: 99 })).toEqual({ from: 1, to: 99 });
  });

  it("runs on a DTO nested in another, with the path of the field", () => {
    expect(issuesOf(() => validate(Holder, { range: { from: 5, to: 1 } }))).toEqual([
      { path: "range", reason: "to is before from" },
    ]);
  });

  it("does not run on a value whose fields are invalid", () => {
    const seen: unknown[] = [];
    @Validate<Probe>((value) => {
      seen.push(value);
      return undefined;
    })
    class Probe {
      @Integer()
      n!: number;
    }
    expect(() => validate(Probe, { n: "x" })).toThrow(DtoValidationError);
    expect(seen).toEqual([]);
  });

  it("reports every issue of a list; false and an empty string fail with the default reason", () => {
    @Validate<Many>(() => ["a", { field: "x", reason: "b" }])
    class Many {
      @Integer()
      x!: number;
    }
    @Validate<No>(() => false)
    class No {
      @Integer()
      x!: number;
    }
    @Validate<Blank>(() => "")
    class Blank {
      @Integer()
      x!: number;
    }
    expect(issuesOf(() => validate(Many, { x: 1 }))).toEqual([
      { path: "(root)", reason: "a" },
      { path: "x", reason: "b" },
    ]);
    expect(issuesOf(() => validate(No, { x: 1 }))[0]?.reason).toBe("validation failed");
    expect(issuesOf(() => validate(Blank, { x: 1 }))[0]?.reason).toBe("validation failed");
  });

  it("true, undefined and [] are valid", () => {
    for (const result of [true, undefined, []] as const) {
      @Validate<Fine>(() => result)
      class Fine {
        @Integer()
        x!: number;
      }
      expect(validate(Fine, { x: 1 })).toEqual({ x: 1 });
    }
  });

  it("fails closed: a throwing check and a non-sync result are failures, with no text of the error", () => {
    @Validate<Throws>(() => {
      throw new Error("secret 4111111111111111");
    })
    class Throws {
      @Integer()
      x!: number;
    }
    @Validate<Async>((() => Promise.resolve(true)) as never)
    class Async {
      @Integer()
      x!: number;
    }
    @Validate<Odd>((() => 42) as never)
    class Odd {
      @Integer()
      x!: number;
    }
    for (const dto of [Throws, Async, Odd]) {
      const issues = issuesOf(() => validate(dto, { x: 1 }));
      expect(issues).toEqual([{ path: "(root)", reason: "validation failed" }]);
    }
  });

  it("the JSON Schema of a validated DTO is still a clean object root", () => {
    const schema = jsonSchemaOf(Range);
    expect(schema.type).toBe("object");
    expect(schema.allOf).toBeUndefined();
    expect(Object.keys(schema.properties as object)).toEqual(["from", "to"]);
  });
});

describe("#1292b: @KeyText", () => {
  class Order {
    @KeyText({ prompt: "the order id" })
    id!: string;
    @KeyText({ optional: true, pattern: /^[a-z0-9-]+$/, maxLength: 12 })
    slug?: string;
  }

  it("accepts a key and refuses each breach of the key rules, naming the rule and not the text", () => {
    expect(validate(Order, { id: "order:42" })).toEqual({ id: "order:42" });
    for (const bad of ["", "a".repeat(201), "order​42", " lead", "a\u0000b", "é", "\ud800"]) {
      const issues = issuesOf(() => validate(Order, { id: bad }));
      expect(issues).toHaveLength(1);
      expect(issues[0]?.path).toBe("id");
      expect(issues[0]?.reason).not.toContain("order");
    }
  });

  it("accepts only the ASCII identifier syntax [a-zA-Z0-9._:-]+ (#1292c)", () => {
    for (const good of ["A-1", "a.b_c:d", "ORDER:42", "0"]) {
      expect(validate(Order, { id: good })).toEqual({ id: good });
    }
    for (const bad of ["a b", "a/b", "a?b", "a#b", "a%2Fb", 'a"b', "a'b", "аbc", "ａbc", "a\\b"]) {
      const issues = issuesOf(() => validate(Order, { id: bad }));
      expect(issues).toHaveLength(1);
      expect(issues[0]?.path).toBe("id");
      expect(issues[0]?.reason).not.toContain(bad);
    }
  });

  it("the options only narrow a key", () => {
    expect(validate(Order, { id: "x", slug: "ab-1" }).slug).toBe("ab-1");
    expect(() => validate(Order, { id: "x", slug: "AB" })).toThrow(DtoValidationError);
    expect(() => validate(Order, { id: "x", slug: "a".repeat(13) })).toThrow(DtoValidationError);
  });

  it("keeps the prompt in the JSON Schema", () => {
    const properties = jsonSchemaOf(Order).properties as Record<string, { description?: string }>;
    expect(properties.id?.description).toBe("the order id");
  });
});

describe("#1292b: MoneyDto follows the currency's minor unit", () => {
  const issues = (amount: string, currency: string): readonly DtoIssue[] =>
    issuesOf(() => validate(MoneyDto, { amount, currency }));

  it("JPY has no digits after the point, USD two, KWD three, CLF four", () => {
    expect(validate(MoneyDto, { amount: "500", currency: "JPY" }).amount).toBe("500");
    expect(issues("500.1", "JPY")[0]?.path).toBe("amount");
    expect(validate(MoneyDto, { amount: "19.99", currency: "USD" }).amount).toBe("19.99");
    expect(issues("19.999", "USD")[0]?.path).toBe("amount");
    expect(validate(MoneyDto, { amount: "1.234", currency: "KWD" }).amount).toBe("1.234");
    expect(issues("1.2345", "KWD")[0]?.path).toBe("amount");
    expect(validate(MoneyDto, { amount: "1.2345", currency: "CLF" }).amount).toBe("1.2345");
    expect(issues("1.23456", "CLF")[0]?.path).toBe("amount");
  });

  it("refuses a code that is no money, and a lower-case or unknown code", () => {
    expect(issues("1", "XAU")[0]?.path).toBe("currency");
    expect(issues("1", "XXX")[0]?.path).toBe("currency");
    expect(issues("1", "usd")[0]?.path).toBe("currency");
    expect(issues("1", "ZZZ")[0]?.path).toBe("currency");
  });
});

describe("#1292b: maskDto", () => {
  class Contact {
    @Text({ sensitive: PiiAction.mask() })
    phone!: string;
  }
  class Account {
    @Text()
    name!: string;
    @Text({ sensitive: PiiAction.mask() })
    secret!: string;
    @Nested(Contact)
    contact!: Contact;
  }

  it("masks sensitive fields, nested ones included, on a plain object", () => {
    const masked = maskDto(Account, {
      name: "Ann",
      secret: "s3cret",
      contact: { phone: "+972521234567" },
    });
    expect(masked.name).toBe("Ann");
    expect(JSON.stringify(masked)).not.toContain("s3cret");
    expect(JSON.stringify(masked)).not.toContain("972521234567");
  });
});
