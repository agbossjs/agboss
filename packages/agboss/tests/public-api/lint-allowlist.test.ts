/**
 * #195 AC1: the examples' import allowlist is generated from package.json#exports — every public
 * entry passes, a deprecated entry or a deep import fails — and the example and the generator
 * templates need no `no-restricted-imports` suppression any more.
 */
import { ESLint } from "eslint";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

const repo = new URL("../../../../", import.meta.url).pathname;
const pkg = z
  .object({
    name: z.string(),
    exports: z.record(z.string(), z.unknown()),
    deprecatedExports: z.record(z.string(), z.string()),
    internalExports: z.array(z.string()),
  })
  .parse(JSON.parse(readFileSync(join(repo, "packages/agboss/package.json"), "utf8")));
const specifier = (subpath: string): string =>
  subpath === "." ? pkg.name : `${pkg.name}/${subpath.slice(2)}`;
const deprecated = Object.keys(pkg.deprecatedExports).map(specifier);
const internal = pkg.internalExports.map(specifier);
const current = Object.keys(pkg.exports)
  .map(specifier)
  .filter((s) => !deprecated.includes(s) && !internal.includes(s));

/** A throwaway project inside examples/ (ignored by the repo's lint), so the examples' rules apply. */
const probe = join(repo, `examples/.scaffold-tmp-allowlist-${String(process.pid)}`);
mkdirSync(join(probe, "src"), { recursive: true });
writeFileSync(
  join(probe, "tsconfig.json"),
  JSON.stringify({ extends: "../../tsconfig.base.json", include: ["src"] }),
);
afterAll(() => {
  rmSync(probe, { recursive: true, force: true });
});

/** The restricted-import messages ESLint gives a file of an example importing `modules`. */
async function restrictedImports(modules: readonly string[]): Promise<string[]> {
  const file = join(probe, "src", "imports.ts");
  const code = modules.map((m, i) => `import * as m${String(i)} from "${m}";\n`).join("");
  writeFileSync(
    file,
    `${code}export const all = [${modules.map((_, i) => `m${String(i)}`).join(", ")}];\n`,
  );
  const [result] = await new ESLint({ cwd: repo, ignore: false }).lintFiles([file]);
  const messages = result?.messages ?? [];
  expect(messages.filter((message) => message.fatal === true)).toEqual([]);
  return messages
    .filter((message) => message.ruleId === "no-restricted-imports")
    .map((message) => message.message);
}

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name.startsWith(".")) return [];
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

describe("the examples' import allowlist (#195)", () => {
  it("allows exactly the public entries of package.json#exports", async () => {
    expect(current).toEqual(expect.arrayContaining(["@agboss/core", "@agboss/core/dto"]));
    expect(await restrictedImports(current)).toEqual([]);
  }, 60_000);

  it("rejects the deprecated entries (pointing to agboss migrate imports) and deep imports", async () => {
    const messages = await restrictedImports([...deprecated, "@agboss/core/dist/index.js"]);

    expect(messages).toHaveLength(deprecated.length + 1);
    expect(messages.slice(0, deprecated.length)).toEqual(
      deprecated.map(
        () => expect.stringContaining("`agboss migrate imports` rewrites it") as unknown,
      ),
    );
    expect(messages.at(-1)).toContain("No deep imports");
  }, 60_000);

  it("#205: rejects @agboss/core/internal, the entry only the agboss CLI is built on", async () => {
    expect(internal).toEqual(["@agboss/core/internal"]);
    expect(await restrictedImports(internal)).toEqual([
      expect.stringContaining("No deep imports") as unknown,
    ]);
  }, 60_000);

  it("AC1: the examples and the generator templates carry no no-restricted-imports suppression", () => {
    const files = [
      ...walk(join(repo, "examples/job-scout")),
      ...walk(join(repo, "examples/flow-patterns")),
      ...walk(join(repo, "packages/agboss-cli/templates")),
    ];
    const suppressed = files.filter((file) =>
      /eslint-disable.*no-restricted-imports/.test(readFileSync(file, "utf8")),
    );

    expect(files.length).toBeGreaterThan(40);
    expect(suppressed).toEqual([]);
  });
});
