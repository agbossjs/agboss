/**
 * #398 PR 4: `agboss check --federation <snapshot…>` — the application's declared contracts
 * against its neighbours' `describe --json` snapshots, read from disk: an incompatible schema or a
 * missing target with its blast radius (exit 3), a compatible neighbour passes, a file that is not a
 * snapshot is `federation.snapshot-schema`.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agboss, envelope, fixture } from "./agboss.js";

const SHOP = fixture("../federation/fixtures/shop.application.ts");
const COMPATIBLE = fixture("../federation/fixtures/compatible-billing.workflow.ts");
const CHANGED = fixture("../federation/fixtures/changed-billing.workflow.ts");

interface CheckResult {
  readonly checks: readonly string[];
  readonly problems: readonly {
    file: string;
    code: string;
    message: string;
    blastRadius?: readonly unknown[];
  }[];
}

/** A folder holding the shop's `describe --json` snapshot, as a neighbour would publish it. */
async function snapshotsDir(): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "agboss-federation-"));
  const described = await agboss(["describe", "--application", SHOP, "--json"], cwd);
  expect(described.code).toBe(0);
  mkdirSync(join(cwd, "snapshots"));
  writeFileSync(join(cwd, "snapshots", "shop.json"), described.stdout);
  return cwd;
}

describe("agboss check --federation", () => {
  it("a contract changed under its consumer: each incompatibility with its blast radius, exit 3", async () => {
    const cwd = await snapshotsDir();

    const call = await agboss(
      ["check", "--federation", "snapshots", "--application", CHANGED, "--json"],
      cwd,
    );

    expect(call.code).toBe(3);
    const result = envelope(call).result as CheckResult;
    expect(result.checks).toContain("federation");
    expect(result.problems).toEqual([
      {
        file: join("snapshots", "shop.json"),
        code: "federation.incompatible-schema",
        message:
          'shop-kb-application › billing-desk-a2a-agent → billing-application › billing-workflow-start: input StrictBillingQuestionDto: field "invoiceNumber" is now required; the sender does not send it — affects shop-kb-application › quote-workflow (ask-billing-tool)',
        blastRadius: [
          {
            application: "shop-kb-application",
            workflow: "quote-workflow",
            tool: "ask-billing-tool",
          },
        ],
      },
      expect.objectContaining({
        code: "federation.incompatible-schema",
        message: expect.stringContaining('field "answer" is now required'),
      }),
    ]);
  });

  it("a neighbour that agrees passes; a file that is not a snapshot is a problem of its own", async () => {
    const cwd = await snapshotsDir();
    writeFileSync(join(cwd, "notes.json"), JSON.stringify({ schema: 1, command: "check" }));

    const passed = await agboss(
      ["check", "--federation", "snapshots", "--application", COMPATIBLE],
      cwd,
    );
    const invalid = await agboss(
      ["check", "--federation", "notes.json", "missing", "--application", COMPATIBLE, "--json"],
      cwd,
    );

    expect(passed.code).toBe(0);
    expect(passed.stdout).toContain("federation: 2 applications, 1 consumed contract compared");
    expect(invalid.code).toBe(3);
    expect((envelope(invalid).result as CheckResult).problems).toEqual([
      expect.objectContaining({ file: "notes.json", code: "federation.snapshot-schema" }),
      { file: "missing", code: "federation.snapshot-schema", message: "no such file or folder" },
    ]);
  });

  it("snapshots without the flag, or the flag without snapshots: a usage error, exit 2", async () => {
    const cwd = await snapshotsDir();

    const stray = await agboss(["check", "snapshots", "--application", COMPATIBLE], cwd);
    const bare = await agboss(["check", "--federation", "--application", COMPATIBLE], cwd);

    expect(stray.code).toBe(2);
    expect(stray.stderr).toContain("snapshots go with --federation");
    expect(bare.code).toBe(2);
    expect(bare.stderr).toContain("needs the neighbours' snapshots");
  });
});
