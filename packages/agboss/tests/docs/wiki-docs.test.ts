/**
 * #240: the GitHub Wiki is checked like the repo's docs — `check-docs.mjs --wiki <checkout>` fails on
 * a page whose ts block does not compile or that links to a page that does not exist, and CI runs it
 * on the wiki that goes with the code (#341, #1026: docs/wiki-pending plus the PR's own wiki/ pages;
 * sync-wiki.yml publishes them after the merge; until the 0.1.1 release only the repo's wiki/,
 * linking to the shared Wiki's pages).
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
    'import { Agent, DecidedBy, inline, Router } from "@agboss/core";',
    'import { WorkflowStartTextDto } from "@agboss/core/dto";',
    '@Agent({ name: "coder-agent", description: "Codes", prompt: inline("Code."), model: "m" })',
    "class CoderAgent {}",
    "",
    `@Router({ name: "main-router", description: "Picks", decidedBy: DecidedBy.Model, input: { message: WorkflowStartTextDto }, prompt: inline("Pick."), model: "m", routes: [${route}] })`,
    "export class MainRouter {}",
  );

const home =
  "# Home\n\nThe flow is on [Workflow](Workflow), the rules on [Routers](Routers#isolation).\n";

// each test runs tsc over a generated project: slower than 5 s on CI runners
describe("#240: the wiki is checked like the repo's docs", { timeout: 60_000 }, () => {
  it("a wiki page with a snippet that does not compile fails, naming the page and line (AC2)", async () => {
    const stale = router('route("Code changes").to(CoderAgent)');
    const result = await check({
      "Home.md": home,
      "Workflow.md": "",
      "Routers.md": `# Routers\n\n${stale}\n`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("wiki/Routers.md:9: TS2552 Cannot find name 'route'.");
  });

  it("the same pages written against the current API pass, links included (AC1)", async () => {
    const current = router('{ prompt: "Code changes", target: CoderAgent }');
    const result = await check({
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

  it("a link to a page the wiki does not have fails; scripts and commands are checked as in the repo", async () => {
    const result = await check({
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

  it("--wiki-links: another checkout's pages are link targets, not checked themselves", async () => {
    const dir = scratch();
    dirs.push(dir);
    mkdirSync(join(dir, "wiki"), { recursive: true });
    mkdirSync(join(dir, "shared", ".git"), { recursive: true });
    writeDocs(join(dir, "wiki"), { "Home.md": home, "Workflow.md": "" });
    writeDocs(join(dir, "shared"), {
      "Routers.md": `# Routers\n\n${router('route("Code changes").to(CoderAgent)')}\n`,
    });

    const alone = await checkWiki(dir, "wiki");
    expect(alone.status).toBe(1);
    expect(alone.stderr).toContain('wiki/Home.md:3: the link to "Routers" names no wiki page');

    const linked = await checkWiki(dir, "wiki", "shared");
    expect(linked.stderr).toBe("");
    expect(linked.status).toBe(0);
    expect(linked.stdout).toContain(
      "docs ok: 0 snippets compiled in 2 docs, references and links exist",
    );
  });

  // Until the 0.1.1 release CI checks the repo's own wiki/ (the 0.1.1 pages), the shared Wiki's
  // pages only as link targets: it still documents 0.1.0. At the release this goes back to the
  // shared Wiki plus the change's own pages (#341, #1026, overlaid by wiki-overlay.sh).
  it("CI checks the repo's wiki/ after the static gates, until the 0.1.1 release", () => {
    const ci = readFileSync(join(repo, ".github/workflows/ci.yml"), "utf8");

    // docs/wiki-pending (only pages for code on main), else the published wiki: never a per-PR branch
    expect(ci).not.toContain("docs/wiki/");
    expect(ci).toContain("--heads origin docs/wiki-pending");
    expect(ci).toContain('echo "repository=${GITHUB_REPOSITORY}.wiki"');
    expect(ci).toMatch(
      /uses: actions\/checkout@v\d+\s+with:\s+repository: \$\{\{ steps\.wiki\.outputs\.repository \}\}\s+ref: \$\{\{ steps\.wiki\.outputs\.ref \}\}\s+path: shared-wiki/,
    );
    expect(ci).toContain("run: node scripts/check-docs.mjs --wiki wiki --wiki-links shared-wiki\n");
    expect(ci).not.toContain("run: scripts/wiki-overlay.sh");
    expect(ci).toContain("goes back to the shared-Wiki check");
    expect(ci.indexOf("--wiki wiki ")).toBeGreaterThan(ci.indexOf("run: npm run check:static"));
  });

  it("merged pages are published by wiki-sync.sh after main's CI, fast-forward only (#341, #1026)", () => {
    const sync = readFileSync(join(repo, ".github/workflows/sync-wiki.yml"), "utf8");
    const script = readFileSync(join(repo, "scripts/wiki-sync.sh"), "utf8");

    expect(sync).toMatch(
      /workflow_run:\s+workflows: \[CI\]\s+types: \[completed\]\s+branches: \[main\]/,
    );
    expect(sync).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(sync).toContain("workflow_dispatch:");
    expect(sync).toMatch(/permissions:\s+contents: write/);
    expect(sync).toContain("fetch-depth: 0");
    expect(sync).toContain("scripts/wiki-sync.sh");
    expect(script).toContain('push "${WIKI_URL}" refs/heads/master');
    expect(script).toContain('push "${REPO_URL}" refs/heads/docs/wiki-pending');
    for (const text of [sync, script.replace(/^\s*#.*$/gm, "")])
      expect(text).not.toMatch(/--force|\s-f\s|\+HEAD/);
  });
});
