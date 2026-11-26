/**
 * #1307 (G3): `===`, `!==`, `==` and `!=` on a `Date` compare objects, never instants — the repo's
 * `repo/no-date-identity-compare` fails the gate for core sources and tests, linted here with the repo's own config.
 */
import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const RULE = "repo/no-date-identity-compare";
const FILE = "packages/agboss/src/infrastructure/recovery.ts";

async function findings(code: string, path: string = FILE): Promise<string[]> {
  const eslint = new ESLint({ cwd: root });
  const [result] = await eslint.lintText(code, { filePath: `${root}${path}` });
  return (result?.messages ?? []).filter((m) => m.ruleId === RULE).map((m) => m.message);
}

const body = (lines: string): string =>
  `export function planted(a: Date, b: Date, c: Date | undefined, d: Date | "none"): unknown {\n${lines}\n}\n`;

describe("repo/no-date-identity-compare", () => {
  it("flags every identity operator over two Dates, a Date and a Date | undefined", async () => {
    const found = await findings(
      body("  return [a === b, a !== b, a == b, a != b, c === a, a !== c];"),
    );

    expect(found).toHaveLength(6);
    expect(found[0]).toContain("compares the objects, not the instants");
  }, 60_000);

  it("leaves getTime() compares, nullish and literal compares, and ordering alone", async () => {
    const found = await findings(
      body(
        '  return [a.getTime() === b.getTime(), c === undefined, c !== null, d === "none", a < b, a >= b];',
      ),
    );

    expect(found).toEqual([]);
  }, 60_000);

  it("holds for the core's tests too", async () => {
    const found = await findings(
      body("  return a === b;"),
      "packages/agboss/tests/app/pause-expiry-units.test.ts",
    );

    expect(found).toHaveLength(1);
  }, 60_000);
});
