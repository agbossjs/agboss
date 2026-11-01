/**
 * #305 AC2: the package ships the project skills — `"skills"` in package.json#files, the folder
 * `skills/agboss/` with SKILL.md and its 13 references, the ones `agboss create` and `agboss check`
 * copy into a project. Also checks `"bin"` and `"NOTICE"` in package.json#files.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { outputOf } from "./helpers/process.js";

const PACKAGE = new URL("..", import.meta.url).pathname;

describe("#305 AC2: the package ships the skills and proxy bin", () => {
  it('"skills", "bin", and "NOTICE" are in package.json#files and hold SKILL.md and 13 references', () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")) as {
      bin: Readonly<Record<string, string>>;
      files: readonly string[];
    };

    expect(manifest.bin).toEqual({ agboss: "./bin/agboss.js" });
    expect(manifest.files).toEqual(expect.arrayContaining(["bin", "skills", "NOTICE"]));
    expect(existsSync(join(PACKAGE, "bin/agboss.js"))).toBe(true);
    expect(existsSync(join(PACKAGE, "skills/agboss/SKILL.md"))).toBe(true);
    expect(readdirSync(join(PACKAGE, "skills/agboss/references")).sort()).toEqual([
      "01-composition-and-architecture.md",
      "02-flow-dsl-all-combinations.md",
      "03-components-di-and-lifecycle.md",
      "04-mcp-and-a2a.md",
      "05-channels-and-human-in-the-loop.md",
      "06-finops-providers-and-queues.md",
      "07-guardrails-pii-and-security.md",
      "08-observability-and-tracing.md",
      "09-persistence-k8s-and-deploy.md",
      "10-testing-vcr-and-evals.md",
      "11-cli-studio-and-error-catalog.md",
      "12-end-to-end-recipes.md",
      "13-migrating-from-langgraph.md",
    ]);
  });

  it("packages/agboss/bin/agboss.js resolves the installed agboss-cli locally", async () => {
    const out = await outputOf(process.execPath, [join(PACKAGE, "bin/agboss.js"), "--help"], {
      cwd: PACKAGE,
      env: { ...process.env, AGBOSS_NO_STAR: "1" },
    });

    expect(out).toContain("Usage: agboss <command>");
  });
});
