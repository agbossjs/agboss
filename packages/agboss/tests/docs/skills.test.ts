/**
 * #305 AC1 / AC2: the project skills shipped with agboss (`packages/agboss/skills/agboss/`) are
 * checked by `npm run check:docs` like every doc — their snippets compile, one call per line — and
 * by scripts/docs/skills.mjs: SKILL.md's header is the package's version, every code they mention
 * exists, the matrix names (tests/skills/coverage.ts) are in their files and exported, and the error
 * catalog lists every `RuleCode` once it says it is complete.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SKILL_COVERAGE } from "../skills/coverage.js";
import { checkDocs, repo, scratch } from "./docs-check.js";

const SKILLS = join(repo, "packages/agboss/skills/agboss");
const VERSION = (
  JSON.parse(readFileSync(join(repo, "packages/agboss/package.json"), "utf8")) as {
    version: string;
  }
).version;

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Writes skill files (path inside `skills/agboss/` → Markdown) into a fresh folder and checks them. */
function checkSkills(files: Readonly<Record<string, string>>): ReturnType<typeof checkDocs> {
  const dir = scratch();
  dirs.push(dir);
  const paths = Object.entries(files).map(([path, markdown]) => {
    const file = join(dir, "skills/agboss", path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, markdown);
    return file;
  });
  return checkDocs(dir, paths);
}

const fence = (...lines: string[]): string => ["```ts", ...lines, "```"].join("\n");
const header = (version: string): string =>
  `---\nname: agboss\ndescription: d\n---\n\n<!-- agboss-skills-version: ${version} — managed by \`agboss check\`; edits here are replaced -->\n`;

// each test runs tsc over the written snippets: the whole skill takes ~25 s locally
describe("#305: the project skills in check:docs", { timeout: 120_000 }, () => {
  it("AC1: the shipped SKILL.md and its 13 references pass — header, codes, matrix coverage", () => {
    const references = readdirSync(join(SKILLS, "references")).sort();
    const files = Object.fromEntries([
      ["SKILL.md", readFileSync(join(SKILLS, "SKILL.md"), "utf8")],
      ...references.map((name) => [
        `references/${name}`,
        readFileSync(join(SKILLS, "references", name), "utf8"),
      ]),
    ]) as Record<string, string>;

    const result = checkSkills(files);

    expect(references).toHaveLength(13);
    // stderr may carry Node's warnings (SQLite in a compiled snippet), never a problem
    expect(result.stderr).not.toContain("Docs out of date");
    expect(result.status).toBe(0);
  });

  it("AC1: the matrix coverage names a list for SKILL.md and each of the 13 references", () => {
    const shipped = [
      "SKILL.md",
      ...readdirSync(join(SKILLS, "references")).map((name) => `references/${name}`),
    ].sort();

    expect(Object.keys(SKILL_COVERAGE).sort()).toEqual(shipped);
  });

  it("SKILL.md: the frontmatter first, then the header of the package's version", () => {
    const result = checkSkills({
      "SKILL.md": `${header("0.0.1")}\n# AGBoss\n\nseconds usd\n`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`SKILL.md:6: skills version 0.0.1, agboss is ${VERSION}`);
  });

  it("AC1: a matrix name missing from its file fails, naming the coverage list", () => {
    const result = checkSkills({ "references/12-end-to-end-recipes.md": "# Recipes\n" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "12-end-to-end-recipes.md: does not cover createApp (packages/agboss/tests/skills/coverage.ts)",
    );
  });

  it("an unknown [x.y] code fails; the error catalog is checked once it says it is complete", () => {
    const names = SKILL_COVERAGE["references/11-cli-studio-and-error-catalog.md"] ?? [];
    const stub = `# CLI\n\n${names.join(" ")} \`[graph.dead-end]\`\n`;
    const draft = checkSkills({ "references/11-cli-studio-and-error-catalog.md": stub });
    const complete = checkSkills({
      "references/11-cli-studio-and-error-catalog.md": `<!-- agboss-skills-catalog: complete -->\n${stub}[graph.no-such-rule]\n`,
    });

    expect(draft.status).toBe(0);
    expect(complete.status).toBe(1);
    expect(complete.stderr).toContain("unknown code [graph.no-such-rule]");
    expect(complete.stderr).toContain("the error catalog misses [graph.not-a-node]");
    expect(complete.stderr).not.toContain("misses [graph.dead-end]");
  });

  it("AC2: a snippet that does not compile and a two-call line fail with file:line", () => {
    const result = checkSkills({
      "references/02-flow-dsl-all-combinations.md": [
        "# Flow",
        "",
        "Workflow start WorkflowStart WorkflowFinish WorkflowStartTextDto",
        "",
        fence(
          'import { start } from "agboss";',
          "declare const A: never;",
          "start(A).returns(A).toFinish(A);",
        ),
        "",
      ].join("\n"),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/02-flow-dsl-all-combinations\.md:8: .*newline-per-chained-call/);
  });

  it("a skill names only npx agboss … and npm test, never the repo's npm run or make", () => {
    const result = checkSkills({
      "references/10-testing-vcr-and-evals.md": "# Tests\n\ntestTool — run `npm run check`.\n",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "10-testing-vcr-and-evals.md:3: a skill names only npx agboss … and npm test",
    );
  });

  it("#395 S5: both command lines of a stale cassette pass; a wrong mode or variable does not", () => {
    const passing = checkSkills({
      "references/99-commands.md":
        "# Tests\n\ntestTool — `npx agboss check --cassettes`, then `AGBOSS_VCR_MODE=RECORD_STALE npm test`.\n",
    });
    const failing = checkSkills({
      "references/99-commands.md":
        "# Tests\n\ntestTool — `AGBOSS_VCR_MODE=STALE npm test`, `CI=1 npm test`, `npx agboss check --cassette`.\n",
    });

    expect(passing.stderr).not.toContain("Docs out of date");
    expect(passing.status).toBe(0);
    expect(failing.status).toBe(1);
    expect(failing.stderr).toContain(
      "AGBOSS_VCR_MODE=STALE is not one of RECORD, REPLAY, AUTO, RECORD_STALE",
    );
    expect(failing.stderr).toContain("npm test takes only AGBOSS_VCR_MODE (CI is not one)");
    expect(failing.stderr).toContain("`agboss check` has no option --cassette");
  });
});
