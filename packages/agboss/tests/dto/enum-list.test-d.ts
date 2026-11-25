import { describe, expectTypeOf, it } from "vitest";
import { Enum, List, Text } from "../../src/dto/index.js";

enum Status {
  Draft = "draft",
  Paid = "paid",
}

/** #1292a: the field type must be exactly the enum's union; a list takes mutable and readonly arrays. */
describe("#1292a: type pins", () => {
  it("@Enum fixes the field's type", () => {
    class Ok {
      @Enum(Status)
      status!: Status;
      @Enum(["a", "b"])
      letter!: "a" | "b";
      @Enum(["a", "b"], { optional: true })
      maybe?: "a" | "b";
    }
    class Wrong {
      // @ts-expect-error -- the field's type is the union of the values, not string
      @Enum(["a", "b"])
      letter!: string;
      // @ts-expect-error -- an enum's field is the enum, not a wider string
      @Enum(Status)
      status!: string;
    }
    expectTypeOf<typeof Ok>().toBeConstructibleWith();
    expectTypeOf<typeof Wrong>().toBeConstructibleWith();
  });

  it("@List takes T[] and readonly T[]", () => {
    class Ok {
      @List(Text)
      mutable!: string[];
      @List(Text)
      frozen!: readonly string[];
      @List(Status)
      statuses!: Status[];
      @List(["a", "b"], { optional: true })
      letters?: readonly ("a" | "b")[];
    }
    class Wrong {
      // @ts-expect-error -- a list of text is not a list of numbers
      @List(Text)
      numbers!: number[];
    }
    expectTypeOf<typeof Ok>().toBeConstructibleWith();
    expectTypeOf<typeof Wrong>().toBeConstructibleWith();
  });
});
