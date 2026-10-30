/**
 * #489 AC4: job-scout left the repository for agbossjs/agboss-examples (`08-job-scout`), so no doc
 * may point at `examples/job-scout` — except the pages that record history, the ADRs and the
 * Changelog. `check:docs` (scripts/docs/removed-paths.mjs) fails on such a link in the repo's docs
 * and in the Wiki, naming the doc, the line and where the folder went.
 */
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkDocs, checkWiki, repo, scratch, writeDocs } from "./docs-check.js";

interface RemovedPath {
  readonly path: string;
  readonly movedTo: string;
}
interface RemovedPaths {
  readonly REMOVED_PATHS: readonly RemovedPath[];
  readonly isHistory: (doc: string) => boolean;
  readonly removedPathProblems: (doc: string, markdown: string) => string[];
}
const removedPaths = async (): Promise<RemovedPaths> =>
  (await import(join(repo, "scripts/docs/removed-paths.mjs"))) as RemovedPaths;

const MOVED_TO = "https://github.com/agbossjs/agboss-examples/tree/main/08-job-scout";
const problem = (doc: string, line: number): string =>
  `${doc}:${String(line)}: examples/job-scout left the repository — link ${MOVED_TO} instead`;

const dirs: string[] = [];
const fresh = (): string => {
  const dir = scratch();
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("#489 AC4: no link to examples/job-scout outside ADRs and the Changelog", () => {
  it("job-scout is the one removed folder, and it went to agboss-examples' 08-job-scout", async () => {
    const { REMOVED_PATHS } = await removedPaths();

    expect(REMOVED_PATHS).toEqual([{ path: "examples/job-scout", movedTo: MOVED_TO }]);
  });

  it.each([
    ["a Markdown link to the folder", "See [the example](examples/job-scout)."],
    ["a link into the folder", "See [its workflow](examples/job-scout/src/job-scout.workflow.ts)."],
    [
      "a GitHub URL of the folder",
      "https://github.com/agbossjs/agboss/tree/main/examples/job-scout",
    ],
    ["a relative path into the folder", "Open ./examples/job-scout/README.md"],
    ["a command in a code span", "Run `cd examples/job-scout && npm run chat`."],
    ["the folder with a trailing slash", "In `examples/job-scout/` there is …"],
  ])("%s is a problem, naming the doc and the line", async (_kind, text) => {
    const { removedPathProblems } = await removedPaths();

    expect(removedPathProblems("Example.md", `# Example\n\n${text}\n`)).toEqual([
      problem("Example.md", 3),
    ]);
  });

  it("a line inside a fenced block counts too: a command there points at the folder as well", async () => {
    const { removedPathProblems } = await removedPaths();
    const markdown = ["# CLI", "", "```sh", "cd examples/job-scout", "```", ""].join("\n");

    expect(removedPathProblems("CLI.md", markdown)).toEqual([problem("CLI.md", 4)]);
  });

  it("two mentions on one line are one problem; mentions on two lines are two", async () => {
    const { removedPathProblems } = await removedPaths();
    const markdown = "examples/job-scout and examples/job-scout/src\n\nsee examples/job-scout\n";

    expect(removedPathProblems("App.md", markdown)).toEqual([
      problem("App.md", 1),
      problem("App.md", 3),
    ]);
  });

  it.each([
    ["the new home", `[08-job-scout](${MOVED_TO})`],
    ["the examples repository's folder", "cd agboss-examples/08-job-scout"],
    ["another repository's folder of that name", "agboss-examples/job-scout"],
    ["a longer folder name", "examples/job-scout-reference"],
    ["the example that stays", "examples/flow-patterns"],
    ["job-scout as a label", 'the string "job-scout" in a trace tag'],
  ])("%s is not a problem", async (_kind, text) => {
    const { removedPathProblems } = await removedPaths();

    expect(removedPathProblems("Home.md", `${text}\n`)).toEqual([]);
  });

  it.each([
    ["ADR-0011-Example-in-the-monorepo.md", true],
    ["wiki/ADR-0025-Examples-live-in-agbossjs-agboss-examples.md", true],
    ["Changelog.md", true],
    ["CHANGELOG.md", true],
    ["Example.md", false],
    ["ADR.md", false],
    ["Changelog-notes.md", false],
    ["README.md", false],
  ])("%s records history: %s", async (doc, expected) => {
    const { isHistory, removedPathProblems } = await removedPaths();

    expect(isHistory(doc)).toBe(expected);
    expect(removedPathProblems(doc, "examples/job-scout\n")).toHaveLength(expected ? 0 : 1);
  });

  // the next two spawn check-docs, as `npm run check:docs` and CI's wiki step do
  it("check:docs fails on a repo doc that links the folder; the Changelog keeps its mention", () => {
    const dir = fresh();
    const docs = writeDocs(dir, {
      "guide.md": "# Guide\n\nTry [job-scout](examples/job-scout).\n",
      "CHANGELOG.md": "# Changelog\n\n- job-scout added in examples/job-scout\n",
    });

    const result = checkDocs(dir, docs);

    expect(result.status).toBe(1);
    expect(result.stderr.trim().split("\n").slice(1)).toEqual([`  ${problem("guide.md", 3)}`]);
  }, 60_000);

  it("check:docs --wiki fails on a current page that links the folder; ADRs keep theirs", () => {
    const dir = fresh();
    const wiki = join(dir, "wiki");
    mkdirSync(join(wiki, ".git"), { recursive: true });
    writeDocs(wiki, {
      "Home.md": "# Home\n\nSee [Example](Example).\n",
      "Example.md": "# Example\n\nThe code: examples/job-scout/src\n",
      "ADR-0011-Example.md": "# ADR-0011\n\nThe example lives in `examples/job-scout`.\n",
      "Changelog.md": "# Changelog\n\n- examples/job-scout\n",
    });

    const result = checkWiki(dir, "wiki");

    expect(result.status).toBe(1);
    expect(result.stderr.trim().split("\n").slice(1)).toEqual([
      `  ${problem("wiki/Example.md", 3)}`,
    ]);
  }, 60_000);

  it("the repo's own docs pass the rule: none of them links the folder any more", async () => {
    const { removedPathProblems } = await removedPaths();
    const docs = ["README.md", "CLAUDE.md", "QUALITY.md", "WORKFLOW.md", "CONTRIBUTING.md"];
    const extra = ["packages/agboss/README.md", "RELEASE_CHECKLIST.md"];

    const problems = [...docs, ...extra].flatMap((doc) =>
      removedPathProblems(doc, readFileSync(join(repo, doc), "utf8")),
    );

    expect(problems).toEqual([]);
  });
});
