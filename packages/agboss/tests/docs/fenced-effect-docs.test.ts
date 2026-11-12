/**
 * #906 AC5: no doc of the repository tells a component to inject a store's own class for a fenced
 * effect — `deps: [ExecutionContext, FencedEffects]` is the way (#890): the store is infrastructure,
 * listed in `@Application({ providers })`, never in a component's `deps`. (The Wiki's pages are
 * checked by `check:docs --wiki`; the page that said so, Several-instances, is fixed with this.)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { repo } from "./docs-check.js";

const DOC_ROOTS = [
  "README.md",
  "CLAUDE.md",
  "QUALITY.md",
  "WORKFLOW.md",
  "packages/agboss/README.md",
  "packages/agboss/skills",
];
/** A store's class in a component's `deps: [...]`. */
const STORE_IN_DEPS =
  /deps:\s*\[[^\]]*\b(?:Sqlite|Postgres|Mongo|InMemory)FencedEffectRepository\b/u;

const docsUnder = (path: string): string[] => {
  const full = join(repo, path);
  if (!statSync(full).isDirectory()) return [path];
  return readdirSync(full, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? docsUnder(join(path, entry.name))
      : entry.name.endsWith(".md")
        ? [join(path, entry.name)]
        : [],
  );
};

describe("#906 AC5: no doc injects a store class for a fenced effect", () => {
  const docs = DOC_ROOTS.flatMap(docsUnder);

  it("AC5: the docs are found", () => {
    expect(docs.length).toBeGreaterThan(10);
  });

  it("AC5: none lists a fenced-effect store class in a component's deps", () => {
    const found = docs.flatMap((doc) =>
      readFileSync(join(repo, doc), "utf8")
        .split("\n")
        .flatMap((line, at) =>
          STORE_IN_DEPS.test(line) ? [`${relative(repo, join(repo, doc))}:${String(at + 1)}`] : [],
        ),
    );

    expect(found).toEqual([]);
  });

  it("AC5: they say `FencedEffects` where the typed transaction is explained", () => {
    const skill = readFileSync(
      join(repo, "packages/agboss/skills/agboss/references/09-persistence-k8s-and-deploy.md"),
      "utf8",
    );

    expect(skill).toContain("inject `FencedEffects`");
  });
});
