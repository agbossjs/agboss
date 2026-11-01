/**
 * #195 AC3: a change of the public surface shows up as a diff of the committed API reports
 * (packages/agboss/api/*.api.md, one per package.json export). `npm run check` runs the same
 * check in CI. Runs api-extractor on `dist`: build the package first.
 */
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runNode } from "../helpers/process.js";

const repo = new URL("../../../../", import.meta.url).pathname;
const reports = join(repo, "packages/agboss/api");
const copy = mkdtempSync(join(tmpdir(), "agboss-api-reports-"));

// awaited, never spawnSync: two api-extractor runs held this fork 53 s on CI, and a fork held 60 s
// drops the fault suite from the run (#630)
const check = (...args: string[]) =>
  runNode([join(repo, "scripts/api-report.mjs"), ...args], { cwd: repo });

afterAll(() => {
  rmSync(copy, { recursive: true, force: true });
});

describe("API reports (#195)", () => {
  it("one committed report per entry of package.json#exports", () => {
    const pkg = JSON.parse(readFileSync(join(repo, "packages/agboss/package.json"), "utf8")) as {
      exports: Record<string, unknown>;
    };
    const names = Object.keys(pkg.exports).map((subpath) =>
      subpath === "." ? "agboss.api.md" : `agboss-${subpath.slice(2).replaceAll("/", "-")}.api.md`,
    );

    expect(
      readdirSync(reports)
        .filter((name) => name.endsWith(".api.md"))
        .sort(),
    ).toEqual(names.sort());
  });

  it("AC3: the committed reports match the build, and a surface change fails the check", async () => {
    expect((await check()).status, "npm run build, then npm run api:update").toBe(0);

    cpSync(reports, copy, { recursive: true });
    const units = join(copy, "agboss-units.api.md");
    writeFileSync(
      units,
      readFileSync(units, "utf8").replace("export const minutes", "export const hours"),
    );
    const changed = await check("--reports", copy);

    expect(changed.status).toBe(1);
    expect(changed.stderr).toContain("The public API changed without its report (#195): ./units.");
  }, 120_000);
});
