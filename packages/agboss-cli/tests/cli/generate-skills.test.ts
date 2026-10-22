/**
 * #305 AC4: `agboss generate` syncs the project skills before it writes its files (a dry run
 * writes nothing), and `result.skills` is in `--json`.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { workflowDeclaration, writeApplication } from "../scaffold/application-fixture.js";
import { agboss, envelope } from "./agboss.js";

const DESK = { module: "src/desk/desk.workflow.ts", className: "Desk", name: "desk-workflow" };

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "agboss-generate-skills-"));
  writeApplication(root, DESK);
  mkdirSync(join(root, "src/desk"), { recursive: true });
  writeFileSync(join(root, DESK.module), workflowDeclaration(DESK));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ agboss: { application: "src/desk.application.ts" }, scripts: {} }),
  );
  return root;
}

describe("#305 AC4: agboss generate syncs the project skills", () => {
  it("before writing: the skills line first, then the files written", async () => {
    const root = project();

    const call = await agboss(["generate", "workflow", "checkout-workflow"], root);

    expect(call.code, call.stderr).toBe(0);
    const lines = call.stdout.split("\n");
    const skills = lines.findIndex((line) =>
      line.startsWith("skills: .claude/skills/agboss installed"),
    );
    const written = lines.findIndex((line) => line.includes("src/checkout/checkout.workflow.ts"));
    expect(skills).toBeGreaterThanOrEqual(0);
    expect(written).toBeGreaterThan(skills);
    expect(existsSync(join(root, ".claude/skills/agboss/SKILL.md"))).toBe(true);
  });

  it("--json carries result.skills; --dry-run syncs nothing", async () => {
    const root = project();

    const dry = await agboss(["generate", "workflow", "checkout-workflow", "--dry-run"], root);
    const isSyncedByDryRun = existsSync(join(root, ".claude/skills/agboss"));
    const call = await agboss(["generate", "workflow", "checkout-workflow", "--json"], root);

    expect(dry.stdout).not.toContain("skills:");
    expect(isSyncedByDryRun).toBe(false);
    expect((envelope(call).result as { skills: unknown }).skills).toMatchObject({
      status: "installed",
    });
  });
});
