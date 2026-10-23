/**
 * #386 AC1: `RuleCode` holds only codes some rule reports. A rule reports its code as a literal
 * (`violation("graph.dead-end", …)`, `reportOnce("graph.wrong-kind", …)`, a ternary of two codes),
 * and the compiler keeps every such literal a `RuleCode` — so the codes the framework can emit are
 * the members whose literal appears in its source outside the declaration.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = new URL("../../src/", import.meta.url).pathname;
const DECLARATION = join(SRC, "graph/rule-error.ts");

/** Every `.ts` file under `dir`, recursively. */
function sourceFiles(dir: string): readonly string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** The members of the `RuleCode` union, in declaration order. */
function declaredCodes(): readonly string[] {
  const declaration = readFileSync(DECLARATION, "utf8");
  const union = /export type RuleCode =([^;]*);/u.exec(declaration)?.[1] ?? "";
  return [...union.matchAll(/\|\s*"([^"]+)"/gu)].map((match) => match[1] ?? "");
}

/** The string literals of the framework's source outside the declaration. */
function sourceLiterals(): ReadonlySet<string> {
  const files = sourceFiles(SRC).filter((file) => file !== DECLARATION);
  const literals = files.flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/"([a-z-]+(?:\.[a-z-]+)+)"/gu)].map(
      (match) => match[1] ?? "",
    ),
  );
  return new Set(literals);
}

describe("#386: RuleCode", () => {
  it("AC1: holds exactly the codes some rule of the framework reports", () => {
    const declared = declaredCodes();
    const literals = sourceLiterals();

    const emitted = declared.filter((code) => literals.has(code));

    expect(declared.length).toBeGreaterThan(100);
    expect(declared).toEqual(emitted);
  });
});
