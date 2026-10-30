/**
 * #523 AC3 — `RELEASE_CHECKLIST.md` states the install policy: the lockfiles (`npm ci`), the
 * minimum release age (`--before`, 3 days) and its one override (`AGBOSS_NPM_BEFORE`, the
 * maintainer's, locally). The section is checked by check-docs's own reference check — every
 * `scripts/…`, `npm run …` and `make …` it names exists in this repository. (The rest of the
 * checklist runs commands of agbossjs/agboss-examples, so the whole file is not a checked doc.)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repo = new URL("../../../../", import.meta.url).pathname;

interface Known {
  readonly repo: string;
}
interface References {
  readonly knownOf: (repo: string, commands: ReadonlyMap<string, unknown>) => Known;
  readonly referenceProblems: (doc: string, markdown: string, known: Known) => readonly string[];
}
const { knownOf, referenceProblems } = (await import(
  join(repo, "scripts/docs/references.mjs")
)) as References;

const HEADING = "## Dependency installs: lockfiles and the minimum release age (#523)";
const checklist = readFileSync(join(repo, "RELEASE_CHECKLIST.md"), "utf8");
const start = checklist.indexOf(HEADING);
const policy = checklist.slice(start, checklist.indexOf("\n---", start));

describe("AC3: RELEASE_CHECKLIST.md states the install policy", () => {
  it("AC3: has the policy's section", () => {
    expect(start).toBeGreaterThan(-1);
  });

  it("AC3: a lockfile where there is one: npm ci, checked by check:installs", () => {
    expect(policy).toContain("**A lockfile where there is one: `npm ci`.**");
    expect(policy).toContain("`npm run check:installs`");
  });

  it("AC3: a minimum release age of 3 days where ranges are resolved, @agboss/* tarballs exempt", () => {
    expect(policy).toContain("**A minimum release age of 3 days where ranges must be resolved:**");
    expect(policy).toContain("`npm install --before=<now − 3 days>`");
    expect(policy).toContain("`@agboss/*` tarballs installed by path are exempt");
  });

  it("AC3: npx only pinned; AGBOSS_NPM_BEFORE only by the maintainer, locally, never in a workflow", () => {
    expect(policy).toContain("**`npx` only for a package pinned to an exact version**");
    expect(policy).toContain("only by the maintainer, locally, at release time");
    expect(policy).toContain("Never in a workflow");
  });

  it("AC3: the install right after publishing names the override", () => {
    expect(checklist).toContain(
      'AGBOSS_NPM_BEFORE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \\\n     npm run verify:published',
    );
  });

  it("AC3: every script, npm run and make the section names exists (check-docs's reference check)", () => {
    const problems = referenceProblems("RELEASE_CHECKLIST.md", policy, knownOf(repo, new Map()));

    expect(problems).toEqual([]);
  });
});
