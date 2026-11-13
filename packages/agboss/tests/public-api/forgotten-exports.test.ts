/**
 * #895: a public signature may name only types some public entry exports (`./internal` does not
 * count). AC1: no committed report holds `ae-forgotten-export`. AC2: a public type that references
 * an unexported one fails the check — run on a small declaration-only package, so the real reports
 * stay as they are.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runNode } from "../helpers/process.js";

const repo = new URL("../../../../", import.meta.url).pathname;
const script = join(repo, "scripts/api-report.mjs");
const made: string[] = [];

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A package with a root entry, `./extra` and `./internal`, each file given as its declarations. */
function fixture(files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), "agboss-forgotten-"));
  made.push(dir);
  const entry = (types: string) => ({ types, import: types.replace(".d.ts", ".js") });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "@fixture/pkg",
      version: "1.0.0",
      type: "module",
      exports: {
        ".": entry("./dist/index.d.ts"),
        "./extra": entry("./dist/extra.d.ts"),
        "./internal": entry("./dist/internal.d.ts"),
      },
      internalExports: ["./internal"],
    }),
  );
  writeFileSync(
    join(dir, "tsconfig.build.json"),
    JSON.stringify({ compilerOptions: { module: "NodeNext", strict: true }, include: ["dist"] }),
  );
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, "dist", name)), { recursive: true });
    writeFileSync(join(dir, "dist", name), text);
  }
  return dir;
}

const check = (dir: string) =>
  runNode([script, "--package", dir, "--write", "--reports", join(dir, "api")], { cwd: repo });

const hole = "export interface Hidden { readonly secret: string }\n";
const user =
  'import type { Hidden } from "./hidden.js";\nexport declare function use(h: Hidden): void;\n';

describe("forgotten exports (#895)", () => {
  it("AC1: no committed API report holds ae-forgotten-export", () => {
    const reports = join(repo, "packages/agboss/api");
    for (const name of readdirSync(reports)) {
      expect(readFileSync(join(reports, name), "utf8"), name).not.toContain("ae-forgotten-export");
    }
  });

  it("AC2: a public signature that names a type no public entry exports fails the check", async () => {
    const dir = fixture({
      "index.d.ts": user,
      "extra.d.ts": "export {};\n",
      "internal.d.ts": 'export type { Hidden } from "./hidden.js";\n',
      "hidden.d.ts": hole,
    });
    const run = await check(dir);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("no public entry exports (#895)");
    expect(run.stderr).toContain("Hidden");
  }, 60_000);

  it("a type another public entry exports is no hole", async () => {
    const dir = fixture({
      "index.d.ts": user,
      "extra.d.ts": 'export type { Hidden } from "./hidden.js";\n',
      "internal.d.ts": "export {};\n",
      "hidden.d.ts": hole,
    });
    const run = await check(dir);

    expect(run.stderr).not.toContain("no public entry exports");
    expect(run.status).toBe(0);
    expect(readFileSync(join(dir, "api/fixture.api.md"), "utf8")).not.toContain(
      "ae-forgotten-export",
    );
  }, 60_000);

  it("a public signature that names an @internal type (stripped from the declarations) fails with the #895 message", async () => {
    // `stripInternal` removed `Stripped`; the signature keeps naming it — api-extractor alone stops
    // with `InternalError: Unable to follow symbol`
    const dir = fixture({
      "index.d.ts": "export declare function use(h: Stripped): void;\n",
      "extra.d.ts": "export {};\n",
      "internal.d.ts": "export {};\n",
    });
    const run = await check(dir);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("no declaration holds (#895)");
    expect(run.stderr).toContain("Stripped — dist/index.d.ts");
    expect(run.stderr).toContain("@internal");
    expect(run.stderr).not.toContain("InternalError");
  }, 60_000);
});
