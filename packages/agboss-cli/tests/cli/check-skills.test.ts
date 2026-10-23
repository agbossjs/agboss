/**
 * #305 AC4: `agboss check` syncs the project skills before the assembly — `result.skills` in
 * `--json`, the `skills: …` line when it wrote, warnings that never change the exit code, and
 * `"agboss": { "skills": false }` to turn it off.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agboss, envelope, fixture } from "./agboss.js";

const WORKFLOW = fixture("test-workflow/test.workflow.ts");

/** An AGBoss project: a package.json with the `agboss` field (the application given by flag). */
function projectWith(agboss: Readonly<Record<string, unknown>>): string {
  const root = mkdtempSync(join(tmpdir(), "agboss-check-skills-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "desk", agboss }));
  return root;
}

describe("#305 AC4: agboss check syncs the project skills", () => {
  it("installs them before the report; --json carries result.skills", async () => {
    const root = projectWith({});

    const call = await agboss(["check", "--application", WORKFLOW, "--json"], root);

    expect(call.code).toBe(0);
    expect(call.stderr).toMatch(
      /^skills: \.claude\/skills\/agboss installed for agboss \S+ \(14 files\)\n/,
    );
    expect((envelope(call).result as { skills: unknown }).skills).toMatchObject({
      status: "installed",
      folder: ".claude/skills/agboss",
      removed: [],
    });
  });

  it("current skills print nothing", async () => {
    const root = projectWith({});
    await agboss(["check", "--application", WORKFLOW], root);

    const call = await agboss(["check", "--application", WORKFLOW], root);

    expect(call.code).toBe(0);
    expect(call.stdout).not.toContain("skills:");
  });

  it('"skills": false — off: nothing printed, nothing written', async () => {
    const root = projectWith({ skills: false });

    const call = await agboss(["check", "--application", WORKFLOW, "--json"], root);

    expect(call.code).toBe(0);
    expect(call.stderr).not.toContain("skills");
    expect((envelope(call).result as { skills: unknown }).skills).toMatchObject({ status: "off" });
  });

  it("a folder that cannot be written is a warning: exit 0, the warning in the envelope", async () => {
    const root = projectWith({});
    writeFileSync(join(root, ".claude"), "not a folder");

    const call = await agboss(["check", "--application", WORKFLOW, "--json"], root);

    expect(call.code).toBe(0);
    expect(envelope(call).warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/^\[skills\.sync-failed\] /)]),
    );
  });

  it('"skills" that is not a boolean is the project\'s to fix (exit 3)', async () => {
    const root = projectWith({ skills: "no" });

    const call = await agboss(["check", "--application", WORKFLOW], root);

    expect(call.code).toBe(3);
    expect(call.stderr).toContain('"agboss": { "skills" } must be true or false');
  });

  it("outside an AGBoss project (no package.json with the agboss field) nothing is synced", async () => {
    const root = mkdtempSync(join(tmpdir(), "agboss-check-skills-"));
    writeFileSync(join(root, "package.json"), '{ "name": "plain" }');

    const call = await agboss(["check", "--application", WORKFLOW, "--json"], root);

    expect(call.code).toBe(0);
    expect(envelope(call).result).not.toHaveProperty("skills");
  });
});
