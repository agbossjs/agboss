import { describe, expect, expectTypeOf, it } from "vitest";
import { GuardrailVerdict, InputGuardrail, OutputGuardrail, inline } from "../../src/index.js";
import type { ComponentRecord } from "../../src/index.js";
import type { GuardrailInput } from "../../src/index.js";
import type { Class } from "../../src/components/injection.js";
import type { GuardrailContent, GuardrailHandler } from "../../src/components/guardrail-handler.js";
import type {
  GuardrailComputedOptions,
  GuardrailRefusal,
  GuardrailTextOptions,
} from "../../src/components/policy-decorators.js";

/** #1289: one `check(content)`, no `DecidedBy`, optional names, a model and its provider, the component record. */
describe("#1289: the guardrail options", () => {
  it("a guardrail takes no decidedBy: a question makes it a model one, none a code one", () => {
    // @ts-expect-error -- decidedBy is removed from guardrails
    InputGuardrail({ name: "a-guardrail", description: "a", decidedBy: "code" });
    // @ts-expect-error -- decidedBy is removed from model guardrails too
    OutputGuardrail({ prompt: "?", threshold: 0.5, refusal: "No.", decidedBy: "model" });
  });

  it("name and description are optional, and so are the options of a code guardrail", () => {
    expectTypeOf<GuardrailTextOptions["name"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<GuardrailTextOptions["description"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<GuardrailComputedOptions["name"]>().toEqualTypeOf<string | undefined>();

    @InputGuardrail()
    class Bare implements GuardrailHandler {
      check(): GuardrailVerdict {
        return GuardrailVerdict.passed();
      }
    }
    expect(Bare).toBeTypeOf("function");
    InputGuardrail({ prompt: inline("Is it rude?"), threshold: 0.5, refusal: "Be polite." });
  });

  it("a model guardrail takes a model and its provider; its class has no check(content)", () => {
    expectTypeOf<GuardrailTextOptions["model"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<GuardrailTextOptions["modelProvider"]>().toEqualTypeOf<Class | undefined>();
    expectTypeOf<GuardrailComputedOptions["modelProvider"]>().toEqualTypeOf<Class | undefined>();

    // @ts-expect-error -- a model guardrail's class asks its model: it has no check(content)
    @InputGuardrail({ prompt: "Is it rude?", threshold: 0.5, refusal: "Be polite." })
    class Both implements GuardrailHandler {
      check(): GuardrailVerdict {
        return GuardrailVerdict.passed();
      }
    }
    expect(Both).toBeTypeOf("function");
  });

  it("a guardrail names the component it checks as a ComponentRecord", () => {
    expectTypeOf<GuardrailInput["component"]>().toEqualTypeOf<ComponentRecord>();
    expectTypeOf<GuardrailContent["component"]>().toEqualTypeOf<ComponentRecord>();
    expectTypeOf<GuardrailInput>().not.toHaveProperty("element");
  });

  it("refusal(content) takes the checked content and gives text", () => {
    expectTypeOf<GuardrailRefusal["refusal"]>().parameters.toEqualTypeOf<[GuardrailContent]>();
    expectTypeOf<GuardrailRefusal["refusal"]>().returns.toEqualTypeOf<string | Promise<string>>();

    // @ts-expect-error -- a refusal gives text, never a number
    @InputGuardrail({ prompt: "?", threshold: 0.5 })
    class Numbered {
      refusal(): number {
        return 1;
      }
    }
    expect(Numbered).toBeTypeOf("function");
  });
});
