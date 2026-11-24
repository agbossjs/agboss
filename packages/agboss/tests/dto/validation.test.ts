/** #118 AC5: runtime validation — formats, lengths, ranges, list sizes; each issue with its path and reason. */
import { describe, expect, it } from "vitest";
import {
  CountryCode,
  CurrencyCode,
  IsoDate,
  IsoDateTime,
  Float,
  DecimalString,
  IsoDuration,
  DtoValidationError,
  Email,
  Bool,
  Integer,
  List,
  MediaType,
  Nested,
  Enum,
  PhoneNumber,
  Text,
  TimeZone,
  Url,
  Uuid,
} from "../../src/dto/index.js";
import { validate } from "../../src/dto/schema.js";

class Everything {
  @Text({ minLength: 2, maxLength: 5 }) text!: string;
  @Text({ pattern: /^[A-Z]{2}-\d{4}$/, optional: true }) code?: string;
  @Integer({ min: 1, max: 50 }) count!: number;
  @Float({ min: 0, max: 1 }) score!: number;
  @Bool() done!: boolean;
  @Email() email!: string;
  @Url() url!: string;
  @Uuid() id!: string;
  @IsoDate() day!: string;
  @IsoDateTime() at!: string;
  @IsoDuration() takes!: string;
  @DecimalString({ scale: 2 }) amount!: string;
  @CurrencyCode() currency!: string;
  @CountryCode() country!: string;
  @PhoneNumber() phone!: string;
  @MediaType() type!: string;
  @TimeZone() zone!: string;
  @Enum(["file", "folder"]) kind!: "file" | "folder";
  @List(Text, { minItems: 1, maxItems: 2 }) tags!: string[];
}

const valid = {
  text: "abc",
  count: 3,
  score: 0.5,
  done: true,
  email: "a@b.io",
  url: "https://example.com/x",
  id: "3b241101-e2bb-4255-8caf-4136c566a962",
  day: "2026-10-01",
  at: "2026-10-01T09:00:00Z",
  takes: "PT30M",
  amount: "19.99",
  currency: "USD",
  country: "IL",
  phone: "+972521234567",
  type: "application/pdf",
  zone: "Asia/Jerusalem",
  kind: "file",
  tags: ["x"],
} satisfies Everything;

/** The issue paths a value gets; [] = valid. */
function pathsOf(raw: unknown): string[] {
  try {
    validate(Everything, raw);
    return [];
  } catch (error) {
    if (!(error instanceof DtoValidationError)) throw error;
    return error.issues.map((issue) => issue.path);
  }
}

const reasonOf = (raw: unknown): string => {
  try {
    validate(Everything, raw);
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : "";
  }
};

describe("DTO validation (#118)", () => {
  it("AC5: each decorator accepts a valid value", () => {
    expect(validate(Everything, valid)).toEqual(valid);
    expect(pathsOf({ ...valid, code: "IL-0042", zone: "UTC" })).toEqual([]);
  });

  it.each([
    ["text", "a"],
    ["text", "abcdef"],
    ["code", "il-42"],
    ["count", 2.5],
    ["count", 0],
    ["count", 51],
    ["score", 1.5],
    ["score", Infinity],
    ["done", "yes"],
    ["email", "not-an-email"],
    ["url", "nowhere"],
    ["id", "123"],
    ["day", "2026-13-01"],
    ["at", "tomorrow"],
    ["takes", "30 minutes"],
    ["amount", "19.999"],
    ["amount", "19,99"],
    ["currency", "usd"],
    ["currency", "ABC"],
    ["country", "XX"],
    ["phone", "0521234567"],
    ["type", "pdf"],
    ["zone", "Mars/Olympus"],
    ["kind", "link"],
    ["tags", []],
    ["tags", ["a", "b", "c"]],
  ])("AC5: rejects %s = %j with the field's path", (field, value) => {
    expect(pathsOf({ ...valid, [field]: value })).toEqual([field]);
  });

  it("AC5: a date-time without an offset → dto.date-time-without-offset; with Z or an offset it passes", () => {
    expect(reasonOf({ ...valid, at: "2026-10-01T09:00" })).toMatch(
      /at: dto\.date-time-without-offset/,
    );
    expect(pathsOf({ ...valid, at: "2026-10-01T09:00:00+03:00" })).toEqual([]);
    expect(pathsOf({ ...valid, at: "2026-10-01T09:00:00Z" })).toEqual([]);
  });

  it("AC5: a missing required field and a wrong type are reported by path", () => {
    expect(pathsOf({ ...valid, text: undefined })).toEqual(["text"]);
    expect(pathsOf("not an object")).toEqual(["(root)"]);
  });

  it("AC5: a nested list of DTOs validates each element with an indexed path", () => {
    class Job {
      @Url() url!: string;
    }
    class Jobs {
      @List(Job) jobs!: Job[];
      @Nested(Job, { optional: true }) best?: Job;
    }
    const jobs = [{ url: "https://a.io" }, { url: "https://b.io" }, { url: "nope" }];

    expect(() => validate(Jobs, { jobs, best: { url: "x" } })).toThrow(
      /jobs\[2\]\.url: .*; best\.url: /,
    );
  });

  it("AC5: a decimal string without a scale takes any number of digits after the point", () => {
    class Price {
      @DecimalString() amount!: string;
    }

    expect(validate(Price, { amount: "-19.999" })).toEqual({ amount: "-19.999" });
    expect(() => validate(Price, { amount: "19." })).toThrow(/amount: not a decimal number/);
  });

  it("AC5: a default fills a missing field; an optional field may be left out", () => {
    class Query {
      @Integer({ default: 20 }) count!: number;
      @Text({ optional: true }) note?: string;
    }

    expect(validate(Query, {})).toEqual({ count: 20 });
  });
});
