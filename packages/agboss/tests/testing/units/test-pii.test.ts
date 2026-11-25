/** #262 PR 3 (S55, S62, #120): `testUnit` — what a model reads, and its answer revealed. */
import { PiiError } from "../../../src/core/error-families/limit-errors.js";
import { ConfigError } from "../../../src/core/error-families/config-errors.js";
import { describe, expect, it } from "vitest";
import { replyWith, testUnit } from "../../../src/testing/index.js";
import { usd } from "../../../src/units/index.js";
import {
  CardPiiPolicy,
  ContactPiiPolicy,
  MisnamedPolicy,
  NamePiiPolicy,
  StaffIdPiiPolicy,
} from "../fixtures/units.js";

describe("testUnit", () => {
  it("masks an email as a token and a phone by its part; reveal gives the email back", async () => {
    const pii = testUnit([ContactPiiPolicy]);

    const { output: masked } = await pii.mask("Write to alice@example.com or +1 555 123 4567");

    expect(masked).toMatch(/^Write to <email:[0-9a-f]{6,}> or •+ ?67$/u);
    // only a token is revealed: the phone's part stays one-way
    expect(pii.reveal(masked)).toBe(masked.replace(/<email:[0-9a-f]+>/u, "alice@example.com"));
  });

  it("one value is one token across calls", async () => {
    const pii = testUnit([ContactPiiPolicy]);

    const first = await pii.mask("alice@example.com");
    const second = await pii.mask("ALICE@example.com");

    expect(second.output).toBe(first.output);
  });

  it("a block rule refuses the text", async () => {
    const pii = testUnit([ContactPiiPolicy, CardPiiPolicy]);

    await expect(pii.mask("card 4242 4242 4242 4242")).rejects.toBeInstanceOf(PiiError.Refused);
  });

  it("a project's detector finds what its injected service knows", async () => {
    const pii = testUnit([StaffIdPiiPolicy]);

    const { output } = await pii.mask("ask S-001");

    expect(output).toMatch(/^ask <staff-id:[0-9a-f]{6,}>$/u);
  });

  it("a model detection answers by script; its call is the spend", async () => {
    const pii = testUnit([NamePiiPolicy], {
      model: replyWith('{"found":[{"kind":"person-name","text":"Anna Smith"}]}', {
        cost: usd(0.001),
      }),
    });

    const { output, spend } = await pii.mask("Anna Smith applied");

    expect(output).toBe("<person-name> applied");
    expect(spend.byCaller).toEqual({ "pii:name-pii-policy": 0.001 });
  });

  it("the policies' own rules are checked first: a name that is not kebab-case", () => {
    expect(() => testUnit([MisnamedPolicy])).toThrow(ConfigError.GraphRules);
  });

  it("no policies is a setup error", () => {
    expect(() => testUnit([])).toThrow("name the policies to apply");
  });
});
