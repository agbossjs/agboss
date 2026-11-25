/** #1328b: `testDto(Dto)` validates, masks and describes a DTO at `$0`, with no application. */
import { ValidationError } from "../../src/index.js";
import { describe, expect, expectTypeOf, it } from "vitest";
import { Integer, Nested, Text } from "../../src/dto/index.js";
import { PiiAction } from "../../src/pii/actions.js";
import { testDto } from "../../src/testing/index.js";

class Contact {
  @Text({ sensitive: PiiAction.mask() })
  phone!: string;
}

class Account {
  @Text()
  name!: string;
  @Integer()
  age!: number;
  @Nested(Contact)
  contact!: Contact;
}

const account = testDto(Account);

describe("#1328b: testDto", () => {
  it("validate gives the value the DTO takes", () => {
    const value = account.validate({ name: "Ann", age: 31, contact: { phone: "+972521234567" } });

    expect(value).toMatchObject({ name: "Ann", age: 31 });
    expectTypeOf(value).toEqualTypeOf<Account>();
  });

  it("validate names every issue of data that does not fit", () => {
    expect(() => account.validate({ name: "Ann", age: "old" })).toThrow(ValidationError.DtoInvalid);
  });

  it("mask hides the sensitive fields, nested ones too", () => {
    const masked = account.mask({ name: "Ann", age: 31, contact: { phone: "+972521234567" } });

    expect(masked.name).toBe("Ann");
    expect(JSON.stringify(masked)).not.toContain("972521234567");
  });

  it("jsonSchema is the schema the model sees", () => {
    expect(account.jsonSchema()).toMatchObject({
      type: "object",
      properties: { name: { type: "string" }, age: { type: "integer" } },
    });
  });
});
