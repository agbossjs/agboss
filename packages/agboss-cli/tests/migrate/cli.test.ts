/** #195: `agboss migrate imports` on a project — dry run, write, the files it leaves alone, bad input. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { envelope, agboss } from "../cli/agboss.js";

/** The suppression the old deep imports needed (spelled in parts: the budget counts real ones). */
const DISABLE = ["// eslint-disable-next-line", "no-restricted-imports"].join(" ");
const OLD = [
  DISABLE,
  'import { Agent } from "@agboss/core/core";',
  DISABLE,
  'import { Tool, type ToolHandler } from "@agboss/core/tool";',
  'import { Text } from "@agboss/core/dto";',
  "",
  "export const parts = [Agent, Tool, Text];",
  "export type Handler = ToolHandler<string, string>;",
  "",
].join("\n");
const CURRENT = 'import { Agent } from "@agboss/core";\n\nexport const agent = Agent;\n';

let project = "";
afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

function projectWith(files: Readonly<Record<string, string>>): string {
  project = mkdtempSync(join(tmpdir(), "agboss-migrate-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(project, path, ".."), { recursive: true });
    writeFileSync(join(project, path), content);
  }
  return project;
}

const read = (path: string): string => readFileSync(join(project, path), "utf8");

describe("agboss migrate imports (#195)", () => {
  it("--dry-run lists what would change and writes nothing", async () => {
    projectWith({ "src/a.agent.ts": OLD, "src/b.ts": CURRENT, "node_modules/x/y.ts": OLD });

    const call = await agboss(["migrate", "imports", "--dry-run", "--json"], project);

    expect(call.code).toBe(0);
    expect(envelope(call)).toMatchObject({
      ok: true,
      result: { dryRun: true, plan: { create: [], modify: [{ path: "src/a.agent.ts" }] } },
    });
    expect(read("src/a.agent.ts")).toBe(OLD);
  });

  it("rewrites the old entries in place, in the project's style, and leaves current files alone", async () => {
    projectWith({ "src/a.agent.ts": OLD, "src/b.ts": CURRENT, "tests/c.test.ts": OLD });

    const call = await agboss(["migrate", "imports", "src"], project);

    expect(call).toMatchObject({ code: 0, stderr: "" });
    expect(call.stdout).toContain("src/a.agent.ts");
    expect(call.stdout).toContain("Imports migrated: 1 of 2 files");
    expect(read("src/a.agent.ts")).toBe(
      [
        'import { Agent, Tool, type ToolHandler } from "@agboss/core";',
        'import { Text } from "@agboss/core/dto";',
        "",
        "export const parts = [Agent, Tool, Text];",
        "export type Handler = ToolHandler<string, string>;",
        "",
      ].join("\n"),
    );
    expect(read("src/b.ts")).toBe(CURRENT);
    // only the paths given
    expect(read("tests/c.test.ts")).toBe(OLD);
  });

  it("reports what needs a look by hand on stderr", async () => {
    projectWith({ "src/ns.ts": 'import * as core from "@agboss/core/core";\nexport { core };\n' });

    const call = await agboss(["migrate", "imports"], project);

    expect(call.code).toBe(0);
    expect(read("src/ns.ts")).toBe('import * as core from "@agboss/core";\nexport { core };\n');
    expect(call.stderr).toContain('src/ns.ts:1: "@agboss/core/core" as a whole');
  });

  it("is a usage error without a known migration or with a missing path", async () => {
    projectWith({ "src/a.ts": OLD });

    const unknown = await agboss(["migrate", "everything"], project);
    const missing = await agboss(["migrate", "imports", "nope"], project);
    const none = await agboss(["migrate"], project);

    expect(unknown).toMatchObject({ code: 2 });
    expect(unknown.stderr).toContain('unknown migration "everything", expected "imports"');
    expect(missing).toMatchObject({ code: 2 });
    expect(missing.stderr).toContain("Not found:");
    expect(none.stderr).toContain('expected "imports"');
    expect(read("src/a.ts")).toBe(OLD);
  });
});
