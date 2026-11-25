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
  const assembled = await applicationOf(application, { withoutIdempotencyKeys: true });
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

describe("0.1.1: a snapshot written before the renames is refused by name", () => {
  const snapshotOf = (contracts: unknown): string =>
    JSON.stringify({
      schema: 1,
      command: "describe",
      result: { application: { name: "billing-application", version: "1.0.0", contracts } },
    });
  const renamed =
    "written by agboss before 0.1.1: re-run agboss describe --json; 0.1.1 renamed expose to endpoint and price to costPerCall";
  const exportsOld = [
    { kind: "mcp", expose: "billing-expose", version: "1", tool: "pay", input: null },
  ];
  const importsOld = [
    {
      kind: "a2a",
      client: "billing-a2a-agent",
      target: { application: "x", skill: "pay" },
      usedBy: [],
      input: { dto: "A", schemaHash: "h" },
      output: { dto: "B", schemaHash: "h" },
      price: 0.5,
    },
  ];

  it("an export with expose names the rename", () => {
    expect(
      federationMemberOf(snapshotOf({ exports: exportsOld, imports: [], schemas: {} }), "old.json"),
    ).toEqual({ kind: "invalid", reason: renamed });
  });

  it("an import with price names the rename", () => {
    expect(
      federationMemberOf(snapshotOf({ exports: [], imports: importsOld, schemas: {} }), "old.json"),
    ).toEqual({ kind: "invalid", reason: renamed });
  });

  it("an MCP import whose target has expose names the rename", () => {
    const imports = [
      {
        kind: "mcp",
        server: "s",
        tool: "t",
        target: { application: "x", expose: "e" },
        usedBy: [],
        input: null,
        output: { dto: "B", schemaHash: "h" },
      },
    ];
    expect(
      federationMemberOf(snapshotOf({ exports: [], imports, schemas: {} }), "old.json"),
    ).toEqual({ kind: "invalid", reason: renamed });
  });

  it("a snapshot of the new names is not mistaken for an old one", () => {
    const reading = federationMemberOf(
      snapshotOf({
        exports: [{ kind: "mcp", endpoint: "e", version: "1", tool: "pay", input: null }],
        imports: [],
        schemas: {},
      }),
      "new.json",
    );
    expect(reading.kind).toBe("member");
  });
});
