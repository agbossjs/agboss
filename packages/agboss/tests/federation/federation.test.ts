import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import type { Class } from "../../src/components/injection.js";
import { contractsOf } from "../../src/describe/contracts.js";
import {
  checkFederation,
  FederationProblemCode,
  type FederationMember,
} from "../../src/federation/federation.js";
import { federationMemberOf } from "../../src/federation/federation-snapshot.js";
import { ShopKbApplication } from "../a2a/fixtures/contracts.workflow.js";
import {
  ChangedBillingApplication,
  CompatibleBillingApplication,
  MovedBillingApplication,
} from "./fixtures/billing-applications.js";

async function memberOf(application: Class, file: string): Promise<FederationMember> {
  const assembled = await applicationOf(application);
  return {
    name: assembled.name,
    version: assembled.version,
    file,
    contracts: contractsOf(assembled),
  };
}

/** A member through its `describe --json` envelope, as `--federation` reads it. */
function throughSnapshot(member: FederationMember): FederationMember {
  const envelope = {
    schema: 1,
    ok: true,
    command: "describe",
    result: {
      application: { name: member.name, version: member.version, contracts: member.contracts },
    },
    warnings: [],
  };
  const reading = federationMemberOf(JSON.stringify(envelope), member.file);
  if (reading.kind !== "member") throw new Error(reading.reason);
  return reading.member;
}

describe("#398 PR 4: agboss check --federation compares the declared contracts", () => {
  it("a consumer and a producer that agree: compared, no problem; a third-party server is skipped", async () => {
    const shop = await memberOf(ShopKbApplication, "src/shop.application.ts");
    const billing = throughSnapshot(await memberOf(CompatibleBillingApplication, "billing.json"));

    const report = checkFederation(shop, [billing]);

    expect(report.problems).toEqual([]);
    expect(report.contracts).toBe(1); // kb-application is not among the snapshots
    expect(report.applications.map((application) => application.name)).toEqual([
      "shop-kb-application",
      "billing-application",
    ]);
  });

  it("a changed contract: every incompatibility with its blast radius", async () => {
    const shop = throughSnapshot(await memberOf(ShopKbApplication, "shop.json"));
    const billing = await memberOf(ChangedBillingApplication, "src/billing.application.ts");

    const { problems } = checkFederation(billing, [shop]);

    expect(problems).toEqual([
      {
        code: FederationProblemCode.IncompatibleSchema,
        producer: "billing-application › billing-workflow-start",
        consumer: "shop-kb-application › billing-desk-a2a-agent",
        message:
          'input StrictBillingQuestionDto: field "invoiceNumber" is now required; the sender does not send it',
        file: "shop.json",
        blastRadius: [
          {
            application: "shop-kb-application",
            workflow: "quote-workflow",
            tool: "ask-billing-tool",
          },
        ],
        isWarning: false,
      },
      expect.objectContaining({
        code: FederationProblemCode.IncompatibleSchema,
        message:
          'output of billing-workflow-finish (RenamedBillingAnswerDto) for InvoiceAnswerDto: field "answer" is now required; the sender does not send it',
      }),
    ]);
  });

  it("a start the producer no longer exports is a missing target", async () => {
    const shop = await memberOf(ShopKbApplication, "shop.json");
    const billing = await memberOf(MovedBillingApplication, "billing.json");

    const { problems } = checkFederation(billing, [shop]);

    expect(problems).toEqual([
      expect.objectContaining({
        code: FederationProblemCode.MissingTarget,
        producer: "billing-application › billing-workflow-start",
        message: "billing-application › billing-workflow-start: no such export",
        blastRadius: [expect.objectContaining({ workflow: "quote-workflow" })],
      }),
    ]);
  });

  it("the project's own earlier snapshot: a changed export without a new version warns", async () => {
    const before = throughSnapshot(
      await memberOf(CompatibleBillingApplication, "billing-1.0.0.json"),
    );
    const now = await memberOf(ChangedBillingApplication, "src/billing.application.ts");

    const { problems, applications } = checkFederation(now, [before]);

    expect(applications).toHaveLength(1);
    expect(problems).toEqual([
      expect.objectContaining({
        code: FederationProblemCode.VersionNotBumped,
        isWarning: true,
        message:
          "billing-a2a-expose 1.0.0: its schema changed since billing-1.0.0.json — raise its version",
      }),
    ]);
  });

  it("two snapshots of one application, and a file that is not a snapshot", async () => {
    const shop = await memberOf(ShopKbApplication, "a.json");
    const billing = await memberOf(CompatibleBillingApplication, "src/billing.application.ts");

    const { problems } = checkFederation(billing, [shop, { ...shop, file: "b.json" }]);

    expect(problems).toEqual([
      expect.objectContaining({
        code: FederationProblemCode.DuplicateApplication,
        message:
          "shop-kb-application is given twice (a.json, b.json) — one snapshot per application",
      }),
    ]);
    expect(federationMemberOf("{", "x.json")).toEqual({
      kind: "invalid",
      reason: "not JSON — save it with agboss describe --json",
    });
    expect(federationMemberOf('{"schema":1,"command":"check"}', "x.json")).toEqual({
      kind: "invalid",
      reason: expect.stringContaining(
        "not an agboss describe --json snapshot with contracts at command",
      ),
    });
  });
});
