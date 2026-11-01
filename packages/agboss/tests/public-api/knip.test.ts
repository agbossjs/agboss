/**
 * #205 AC2: an unused dependency fails `npm run check` — its `check:knip` step runs knip, which
 * fails on a dependency nothing imports (and on a file nothing uses).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runNode } from "../helpers/process.js";

const repo = new URL("../../../../", import.meta.url).pathname;
const project = mkdtempSync(join(tmpdir(), "agboss-knip-"));

/** A one-file package depending on `dependencies`; knip's exit code and report on it. */
async function knipOn(
  dependencies: Record<string, string>,
): Promise<{ status: number | null; out: string }> {
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(
    join(project, "src/index.ts"),
    'import { z } from "zod";\nexport const id = z.string();\n',
  );
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({ name: "knip-probe", type: "module", private: true, dependencies }),
  );
  writeFileSync(join(project, "knip.json"), JSON.stringify({ entry: ["src/index.ts"] }));
  const run = await runNode([
    join(repo, "node_modules/knip/bin/knip.js"),
    "--directory",
    project,
    "--no-progress",
  ]);
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

afterAll(() => {
  rmSync(project, { recursive: true, force: true });
});

describe("unused dependencies fail the check (#205)", () => {
  it("AC2: npm run check runs knip", () => {
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts["check:knip"]).toBe("knip");
    expect(pkg.scripts.check?.split(" && ")).toContain("npm run check:knip");
  });

  it("AC2: a dependency nothing imports fails knip; without it, knip passes", async () => {
    const unused = await knipOn({ zod: "^4.0.0", "left-pad": "^1.3.0" });
    const clean = await knipOn({ zod: "^4.0.0" });

    expect(unused.status, unused.out).toBe(1);
    expect(unused.out).toMatch(/Unused dependencies \(1\)\s+left-pad/);
    expect(clean.status, clean.out).toBe(0);
  }, 60_000);
});
