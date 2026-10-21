/**
 * #240: the GitHub Wiki is checked like the repo's docs — `check-docs.mjs --wiki <checkout>` fails on
 * a page whose ts block does not compile or that links to a page that does not exist, and CI runs it
 * on the wiki that goes with the code (#341: a PR's own wiki branch, else docs/wiki-pending, which
 * sync-wiki.yml publishes).
 */
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkWiki, repo, scratch, writeDocs } from "./docs-check.js";

const dirs: string[] = [];
/** A wiki checkout in a fresh folder (`<dir>/wiki`, with a `.git` folder like a clone), checked. */
const check = (pages: Readonly<Record<string, string>>) => {
  const dir = scratch();
  dirs.push(dir);
  const wiki = join(dir, "wiki");
  mkdirSync(join(wiki, ".git"), { recursive: true });
  writeDocs(wiki, pages);
  return checkWiki(dir, "wiki");
};

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const ts = (...lines: string[]): string => ["```ts", ...lines, "```"].join("\n");

const router = (route: string): string =>
  ts(
    'import { Agent, DecidedBy, Router } from "agboss";',
    'import { WorkflowStartTextDto } from "agboss/dto";',
    '@Agent({ name: "coder-agent", description: "Codes", prompt: "Code.", model: "m" })',
    "class CoderAgent {}",
    "",
    `@Router({ name: "main-router", description: "Picks", decidedBy: DecidedBy.Model, input: { message: WorkflowStartTextDto }, prompt: "Pick.", model: "m", routes: [${route}] })`,
    "export class MainRouter {}",
  );

const home =
  "# Home\n\nThe flow is on [Workflow](Workflow), the rules on [Routers](Routers#isolation).\n";

// each test runs tsc over a generated project: slower than 5 s on CI runners
describe("#240: the wiki is checked like the repo's docs", { timeout: 60_000 }, () => {
  it("a wiki page with a snippet that does not compile fails, naming the page and line (AC2)", () => {
    const stale = router('route("Code changes").to(CoderAgent)');
    const result = check({
      "Home.md": home,
      "Workflow.md": "",
      "Routers.md": `# Routers\n\n${stale}\n`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("wiki/Routers.md:9: TS2552 Cannot find name 'route'.");
  });

  it("the same pages written against the current API pass, links included (AC1)", () => {
    const current = router('{ prompt: "Code changes", target: CoderAgent }');
    const result = check({
      "Home.md": home,
      "Workflow.md": "",
      "Routers.md": `# Routers\n\n${current}\n`,
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "docs ok: 1 snippets compiled in 3 docs, references and links exist",
    );
  });

  it("a link to a page the wiki does not have fails; scripts and commands are checked as in the repo", () => {
    const result = check({
      "Home.md": `${home}Run \`npm run test:routers\` or \`agb resume <id>\`.\n`,
      "Workflow.md": "See [the old page](Graph-API) and [the code](https://github.com/x/y).\n",
    });

    expect(result.status).toBe(1);
    expect(result.stderr.trim().split("\n").slice(1)).toEqual([
      "  wiki/Home.md:4: no package has the script `npm run test:routers`",
      "  wiki/Home.md:4: unknown command `agboss resume`",
      '  wiki/Home.md:3: the link to "Routers" names no wiki page',
      '  wiki/Workflow.md:1: the link to "Graph-API" names no wiki page',
    ]);
  });

  it("CI checks the wiki that goes with the code, after the gate (#341)", () => {
    const ci = readFileSync(join(repo, ".github/workflows/ci.yml"), "utf8");

    // a PR's own wiki branch, else docs/wiki-pending, else the published wiki
    expect(ci).toContain('has "docs/wiki/$HEAD_REF"');
    expect(ci).toContain("elif has docs/wiki-pending");
    expect(ci).toContain('echo "repository=${GITHUB_REPOSITORY}.wiki"');
    expect(ci).toMatch(
      /uses: actions\/checkout@v\d+\s+with:\s+repository: \$\{\{ steps\.wiki\.outputs\.repository \}\}\s+ref: \$\{\{ steps\.wiki\.outputs\.ref \}\}\s+path: wiki/,
    );
    expect(ci).toContain("run: node scripts/check-docs.mjs --wiki wiki");
    expect(ci.indexOf("--wiki wiki")).toBeGreaterThan(ci.indexOf("run: make check"));
  });

  it("docs/wiki-pending is published to the wiki, a fast-forward only (#341)", () => {
    const sync = readFileSync(join(repo, ".github/workflows/sync-wiki.yml"), "utf8");

    expect(sync).toMatch(/push:\s+branches: \[docs\/wiki-pending\]/);
    expect(sync).toContain("workflow_dispatch:");
    expect(sync).toMatch(/permissions:\s+contents: write/);
    expect(sync).toContain('git push "$wiki" HEAD:master');
    expect(sync).not.toMatch(/--force|\s-f\s|\+HEAD/);
  });
});
