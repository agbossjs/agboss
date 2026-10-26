/** #118 AC5: the startup check of a DTO class — every field decorated, plain data only. */
import { describe, expect, it } from "vitest";
import { DtoError, Text } from "../../src/dto/index.js";
import { recordField, registerDto } from "../../src/dto/metadata.js";
import { schemaOf } from "../../src/dto/schema.js";

const codeOf = (work: () => unknown): string => {
  try {
    work();
    return "";
  } catch (error) {
    return error instanceof DtoError ? error.code : String(error);
  }
};

describe("DTO registration (#118)", () => {
  it("AC5: a field without a decorator → dto.undecorated-field, naming it", () => {
    class Partly {
      @Text() path!: string;
      mode!: string;
    }

    expect(codeOf(() => schemaOf(Partly))).toBe("dto.undecorated-field");
    expect(() => schemaOf(Partly)).toThrow(/Partly: .* mode/);
  });

  it("AC5: a TS-private field is a field without a decorator at runtime", () => {
    class Hidden {
      @Text() path!: string;
      private secret = "x";
      reveal(): string {
        return this.secret;
      }
    }

    expect(codeOf(() => registerDto(Hidden))).toBe("dto.undecorated-field");
  });

  it("AC5: a method or an accessor → dto.not-plain-data", () => {
    class WithMethod {
      @Text() path!: string;
      describe(): string {
        return this.path;
      }
    }
    class WithGetter {
      @Text() path!: string;
      get upper(): string {
        return this.path.toUpperCase();
      }
    }

    expect(codeOf(() => registerDto(WithMethod))).toBe("dto.not-plain-data");
    expect(() => registerDto(WithGetter)).toThrow(/WithGetter: .* upper/);
  });

  it("AC5: a decorated #private field → dto.not-plain-data (and a compile error)", () => {
    class Sealed {
      // @ts-expect-error — a #private field is not plain data
      @Text() #path!: string;
      @Text() name!: string;
      static pathOf(sealed: Sealed): string {
        return sealed.#path;
      }
    }

    expect(codeOf(() => registerDto(Sealed))).toBe("dto.not-plain-data");
  });

  it("AC5: a subclass keeps its parent's fields first; a valid DTO registers once", () => {
    class Base {
      @Text() id!: string;
    }
    class Child extends Base {
      @Text() name!: string;
    }

    expect(registerDto(Child).map((field) => field.name)).toEqual(["id", "name"]);
    expect(registerDto(Child)).toHaveLength(2);
  });

  it("without decorator metadata the field decorator fails, saying what to import", () => {
    expect(() => {
      recordField(undefined, {
        name: "x",
        kind: "text",
        optional: false,
        settings: {},
        isPrivate: false,
      });
    }).toThrow(/dto\.no-metadata: .*@agboss\/core\/dto/);
  });
});
