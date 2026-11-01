/**
 * #484 AC4 — the fault suite is published: `@agboss/core/testing/faults`, an entry of its own with
 * its API report, never loaded by `@agboss/core` or `@agboss/core/testing` (the root's module
 * budget is untouched), and importable outside vitest — a pod imports it for `withHoldPoints` and
 * its store set's types; there only `faultSuite` is missing.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { runNode } from "../../helpers/process.js";
import * as faults from "../../../src/testing/faults/index.js";

const PACKAGE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SOURCE = join(PACKAGE_ROOT, "src");

/** Every module of src/ that `entry` loads, statically or by `import()`. */
function modulesOf(entry: string): ReadonlySet<string> {
  const seen = new Set<string>();
  const pending = [entry];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    const { importedFiles } = ts.preProcessFile(readFileSync(file, "utf8"), true, true);
    for (const { fileName } of importedFiles) {
      if (!fileName.startsWith(".")) continue;
      const target = resolve(dirname(file), fileName.replace(/\.js$/u, ".ts"));
      if (existsSync(target)) pending.push(target);
    }
  }
  return seen;
}

const isFaultModule = (file: string): boolean => file.includes(join("src", "testing", "faults"));

describe("#484 AC4: the published entry", () => {
  it("package.json exports @agboss/core/testing/faults from the build, with its API report", () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
      exports: Record<string, unknown>;
    };
    expect(pkg.exports["./testing/faults"]).toEqual({
      types: "./dist/testing/faults/index.d.ts",
      import: "./dist/testing/faults/index.js",
    });
    const report = readFileSync(join(PACKAGE_ROOT, "api", "agboss-testing-faults.api.md"), "utf8");
    for (const name of ["faultSuite", "withHoldPoints", "StoreHoldPoint", "OperationHistory"])
      expect(report).toContain(name);
  });

  it("exports the suite, the hold points, the history and the checker", () => {
    expect(Object.keys(faults)).toEqual(
      expect.arrayContaining([
        "faultSuite",
        "runFaultScenario",
        "FAULT_SCENARIOS",
        "withHoldPoints",
        "HoldPoints",
        "StoreHoldPoint",
        "OperationHistory",
        "DatabaseProxy",
        "faultViolationsOf",
        "FaultInvariant",
      ]),
    );
  });

  it("is loaded by neither the root nor @agboss/core/testing", () => {
    for (const entry of ["index.ts", join("testing", "index.ts")])
      expect([...modulesOf(join(SOURCE, entry))].filter(isFaultModule)).toEqual([]);
  });

  it("imports outside vitest: the hold points work there, faultSuite says where it belongs", async () => {
    const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
    const entry = pathToFileURL(join(SOURCE, "testing", "faults", "index.ts")).href;
    const script = `const f = await import(${JSON.stringify(entry)});
      console.log(typeof f.withHoldPoints, typeof f.processHoldPoints.arm);
      try { f.faultSuite({ name: "x", stores: "", database: { url: "" } }); } catch (e) { console.log(e.message); }`;
    const run = await runNode(["--import", loader, "--input-type=module", "-e", script], {
      env: { ...process.env, VITEST: "", VITEST_WORKER_ID: "", VITEST_POOL_ID: "" },
    });
    expect(run.stdout.split("\n")).toEqual([
      "function function",
      "faultSuite registers vitest tests: call it in a vitest test file",
      "",
    ]);
  });
});
