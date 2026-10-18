/** #120 AC3: only the kinds the rules name, a kind rule over a group rule, the longest span. */
import { describe, expect, it } from "vitest";
import { PiiAction, PiiGroup, PiiKind, PiiPolicy, pii, secret } from "../../src/index.js";
import { componentOf } from "../../src/components/metadata.js";
import type { Class } from "../../src/components/injection.js";
import { PiiPolicySet } from "../../src/pii/policy-set.js";
import { DetectionMode, runtimePolicyOf } from "../../src/pii/runtime-policy.js";
import type { PiiPolicyMeta } from "../../src/pii/pii-policy.decorator.js";

const KEY = secret("PII_UNIT_KEY");

/** A policy class's runtime form with a fixed key, no model. */
function policySet(...classes: Class[]): PiiPolicySet {
  const policies = classes.map((cls) => {
    const component = componentOf(cls);
    if (component?.kind !== "pii-policy") throw new Error("not a policy");
    const meta: PiiPolicyMeta = component.meta;
    return runtimePolicyOf({ meta, instance: new (cls as new () => object)(), key: "k" });
  });
  return new PiiPolicySet(policies, "field-key");
}

const masked = async (set: PiiPolicySet, text: string): Promise<string> =>
  (await set.mask(text, {}, DetectionMode.WithModel)).masked.text;

@PiiPolicy({
  name: "email-pii-policy",
  description: "Emails only",
  rules: [pii(PiiKind.Email, PiiAction.replaceWithKind())],
  pseudonymKey: KEY,
})
class EmailPiiPolicy {}

@PiiPolicy({
  name: "contact-group-pii-policy",
  description: "Contact by group, emails by token",
  rules: [
    pii(PiiGroup.Contact, PiiAction.replaceWithKind()),
    pii(PiiKind.Email, PiiAction.replaceWithToken()),
  ],
  pseudonymKey: KEY,
})
class ContactGroupPiiPolicy {}

@PiiPolicy({
  name: "financial-pii-policy",
  description: "Financial and network data",
  rules: [
    pii(PiiGroup.Financial, PiiAction.replaceWithKind()),
    pii(PiiGroup.Network, PiiAction.replaceWithKind()),
    pii(PiiGroup.Credentials, PiiAction.replaceWithKind()),
    pii(PiiGroup.Government, PiiAction.replaceWithKind()),
  ],
  pseudonymKey: KEY,
})
class FinancialPiiPolicy {}

describe("#120 AC3: detection", () => {
  it("only mentioned kinds: an email policy leaves a phone number alone", async () => {
    const text = "alice@example.com or +44 20 7946 0958";
    expect(await masked(policySet(EmailPiiPolicy), text)).toBe("<email> or +44 20 7946 0958");
  });

  it("kind beats group: the email rule over the contact group's", async () => {
    const result = await masked(policySet(ContactGroupPiiPolicy), "a@b.io, call +1 555 123 4567");
    expect(result).toMatch(/^<email:[0-9a-f]{6}>, call <phone>$/);
  });

  it("longest span: an email's domain is not a separate value", async () => {
    const set = policySet(EmailPiiPolicy, FinancialPiiPolicy);
    expect(await masked(set, "mail ann@10.0.0.1.com now")).toBe("mail <email> now");
  });

  it.each([
    ["card (Luhn)", "4111 1111 1111 1111", "4111 1111 1111 1112", "<card-number>"],
    ["IBAN (mod 97)", "GB82 WEST 1234 5698 7654 32", "GB82 WEST 1234 5698 7654 33", "<iban>"],
    ["Israeli ID (check digit)", "000000018", "000000019", "<israeli-id>"],
    ["US SSN (issuance rules)", "123-45-6789", "666-45-6789", "<us-ssn>"],
    ["IPv4 (octets)", "192.168.1.20", "999.168.1.20", "<ip-address>"],
  ])("formats are validated: %s", async (_name, valid, invalid, placeholder) => {
    const set = policySet(FinancialPiiPolicy);
    expect(await masked(set, `x ${valid} y`)).toBe(`x ${placeholder} y`);
    expect(await masked(set, `x ${invalid} y`)).toBe(`x ${invalid} y`);
  });

  it.each([
    ["a US ITIN", "912-70-1234", "<us-itin>"],
    ["a UK NINO", "AB 12 34 56 C", "<uk-nino>"],
    ["a US EIN", "12-3456789", "<us-ein>"],
    ["a SWIFT code", "DEUTDEFF500", "<swift-bic>"],
    ["a MAC address", "00:1A:2B:3C:4D:5E", "<mac-address>"],
    ["coordinates", "51.5007, -0.1246", "<geo-coordinates>"],
    ["an API key", "sk-abcdefghijklmnopqrstuvwxyz123", "<api-key>"],
    ["a JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123", "<jwt>"],
    ["a password", "password: hunter2!", "password: <password>"],
  ])("finds %s", async (_name, value, placeholder) => {
    expect(await masked(policySet(FinancialPiiPolicy), value)).toBe(placeholder);
  });

  it("finds a private key block", async () => {
    const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOg\n-----END RSA PRIVATE KEY-----";
    expect(await masked(policySet(FinancialPiiPolicy), `k: ${key}`)).toBe("k: <private-key>");
  });

  it("the log masks at once with the formats", () => {
    expect(policySet(EmailPiiPolicy).maskNow("from ann@acme.com")).toBe("from <email>");
    expect(policySet().maskNow("from ann@acme.com")).toBe("from ann@acme.com");
  });
});
