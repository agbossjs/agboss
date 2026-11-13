import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import type { Class } from "../../src/components/injection.js";
import { contractsOf } from "../../src/describe/contracts.js";
import { checkFederation, type FederationMember } from "../../src/federation/federation.js";
import { federationMemberOf } from "../../src/federation/federation-snapshot.js";
import { ShopKbApplication } from "../a2a/fixtures/contracts.workflow.js";
import { CompatibleBillingApplication } from "./fixtures/billing-applications.js";

async function memberOf(application: Class, file: string): Promise<FederationMember> {
  const assembled = await applicationOf(application);
  return {
    name: assembled.name,
    version: assembled.version,
    file,
    contracts: contractsOf(assembled),
  };
}

const envelope = (member: FederationMember, contracts: unknown): string =>
  JSON.stringify({
    schema: 1,
    ok: true,
    command: "describe",
    result: { application: { name: member.name, version: member.version, contracts } },
    warnings: [],
  });

/** What a 0.1.0 `describe --json` wrote: exports by `start`, targets by `start`, no `foreign`. */
function earlierContracts(member: FederationMember): unknown {
  return {
    ...member.contracts,
    exports: member.contracts.exports.map((exported) => {
      if (exported.kind !== "a2a") return exported;
      const { skill, ...rest } = exported;
      return { ...rest, start: skill };
    }),
    imports: member.contracts.imports.flatMap((contract) => {
      if (contract.kind !== "a2a") return [contract];
      if (contract.foreign) return [];
      const { foreign: _foreign, target, ...rest } = contract;
      const { skill, ...others } = target;
      return [{ ...rest, target: { ...others, start: skill } }];
    }),
  };
}

describe("#812 AC2: federation pairs (target.application, target.skill) with an export skill", () => {
  it("a foreign @A2AAgent is skipped: no pairing, no [federation.missing-target]", async () => {
    const shop = await memberOf(ShopKbApplication, "shop.json");
    const billing = await memberOf(CompatibleBillingApplication, "billing.json");
    const foreign = shop.contracts.imports.flatMap((contract) =>
      contract.kind === "a2a" && contract.foreign ? [contract.client] : [],
    );

    const report = checkFederation(shop, [billing]);

    expect(foreign).toEqual(["weather-a2a-agent", "oracle-a2a-agent"]);
    expect(report.problems).toEqual([]);
    expect(report.contracts).toBe(1);
  });

  it("a snapshot of an earlier release (exports and targets by start) is read as skills", async () => {
    const shop = await memberOf(ShopKbApplication, "shop.json");
    const billing = await memberOf(CompatibleBillingApplication, "billing.json");

    const readShop = federationMemberOf(envelope(shop, earlierContracts(shop)), "shop.json");
    const readBilling = federationMemberOf(
      envelope(billing, earlierContracts(billing)),
      "billing.json",
    );

    if (readShop.kind !== "member" || readBilling.kind !== "member")
      throw new Error("an earlier snapshot is read");
    expect(readBilling.member.contracts.exports[0]).toMatchObject({
      kind: "a2a",
      skill: "billing-workflow-start",
    });
    expect(readShop.member.contracts.imports[0]).toMatchObject({
      foreign: false,
      target: { application: "billing-application", skill: "billing-workflow-start" },
    });
    expect(checkFederation(readShop.member, [readBilling.member]).problems).toEqual([]);
  });

  it("a snapshot without a skill or a start for an export is invalid, at its export", async () => {
    const billing = await memberOf(CompatibleBillingApplication, "billing.json");
    const [first, ...others] = billing.contracts.exports;
    if (first?.kind !== "a2a") throw new Error("billing exports a skill");
    const { skill: _skill, ...nameless } = first;

    const reading = federationMemberOf(
      envelope(billing, { ...billing.contracts, exports: [nameless, ...others] }),
      "billing.json",
    );

    expect(reading).toEqual({
      kind: "invalid",
      reason: expect.stringContaining("contracts.exports.0"),
    });
  });

  it("a foreign import survives a snapshot, untyped with input and output null", async () => {
    const shop = await memberOf(ShopKbApplication, "shop.json");

    const reading = federationMemberOf(envelope(shop, shop.contracts), "shop.json");

    if (reading.kind !== "member") throw new Error(reading.reason);
    expect(reading.member.contracts.imports).toEqual(shop.contracts.imports);
  });
});
