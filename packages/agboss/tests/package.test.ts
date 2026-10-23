/**
 * #305 AC2: the package ships the project skills — `"skills"` in package.json#files, the folder
 * `skills/agboss/` with SKILL.md and its 13 references, the ones `agboss create` and `agboss check`
 * copy into a project.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGE = new URL("..", import.meta.url).pathname;

describe("#305 AC2: the package ships the skills", () => {
  it('"skills" is in package.json#files and holds SKILL.md and 13 references', () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")) as {
      files: readonly string[];
    };

    expect(manifest.files).toContain("skills");
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
});
