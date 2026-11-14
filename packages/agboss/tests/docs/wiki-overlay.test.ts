/**
 * #1026: a PR carries its Wiki pages in a `wiki/` folder. Its Wiki check compiles the shared Wiki
 * plus the PR's own pages and nothing else; the shared branch only ever holds pages for code that
 * is on main; Sync Wiki publishes the merged pages exactly once. A local harness — a bare "code"
 * repo, a bare Wiki repo, PR branches, GitHub's merge commit made with `git merge --no-ff` — runs
 * the real scripts/wiki-overlay.sh and scripts/wiki-sync.sh, no workflow dispatch.
 */
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runProcess, type ProcessRun } from "../helpers/process.js";
import { checkWiki, repo } from "./docs-check.js";

const env: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST"))),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

const run = (cwd: string, command: string, ...args: string[]): Promise<ProcessRun> =>
  runProcess(command, args, { cwd, env });
/** `git …` in `cwd`; a failure throws with git's message. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await run(cwd, "git", ...args);
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr}${result.stdout}`);
  return result.stdout.trim();
}

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const page = (title: string, body = ""): string => `# ${title}\n\n${body}\n`;
const ts = (code: string): string => ["```ts", code, "```"].join("\n");
const good = ts("export const n: number = 1;");
const bad = ts('export const n: number = "one";');

interface Harness {
  readonly root: string;
  readonly work: string;
  /** A PR branch off main's current tip, with these files (`wiki/…` pages and a code file). */
  pr(name: string, files: Record<string, string>): Promise<void>;
  /** GitHub's squash merge of a PR branch into main, pushed. */
  merge(name: string): Promise<void>;
  /** The PR's check tree: shared Wiki + its own pages, as the `static` job assembles it. */
  tree(name: string): Promise<{ dir: string; overlay: ProcessRun }>;
  /** `scripts/wiki-sync.sh` from a fresh checkout of main. */
  sync(extra?: NodeJS.ProcessEnv): Promise<ProcessRun>;
  /** A page as the Wiki's master / the shared branch holds it (undefined: no such page). */
  wikiPage(name: string): Promise<string | undefined>;
  pendingPage(name: string): Promise<string | undefined>;
  wikiLog(): Promise<string[]>;
  wikiHead(): Promise<string>;
  pendingHead(): Promise<string>;
}

async function harness(): Promise<Harness> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agboss-wiki-overlay-")));
  dirs.push(root);
  const wikiGit = join(root, "wiki.git");
  const codeGit = join(root, "code.git");
  await git(root, "init", "-q", "--bare", "-b", "master", wikiGit);
  await git(root, "init", "-q", "--bare", "-b", "main", codeGit);

  // the Wiki: three pages, mirrored to the shared branch of the code repo
  const wikiClone = join(root, "wiki-clone");
  await git(root, "clone", "-q", wikiGit, wikiClone);
  writeFileSync(join(wikiClone, "Home.md"), page("Home"));
  writeFileSync(join(wikiClone, "Alpha.md"), page("Alpha", "v0"));
  writeFileSync(join(wikiClone, "Beta.md"), page("Beta", "v0"));
  await git(wikiClone, "add", "-A");
  await git(wikiClone, "commit", "-q", "-m", "seed");
  await git(wikiClone, "push", "-q", "origin", "HEAD:master");
  await git(wikiClone, "push", "-q", codeGit, "HEAD:refs/heads/docs/wiki-pending");

  // main: an old commit that has a wiki/ page already (never published), then the scripts
  const work = join(root, "work");
  await git(root, "clone", "-q", codeGit, work);
  await git(work, "checkout", "-q", "-b", "main");
  mkdirSync(join(work, "wiki"));
  writeFileSync(join(work, "wiki/Old.md"), page("Old"));
  await git(work, "add", "-A");
  await git(work, "commit", "-q", "-m", "chore: before the mechanism");
  mkdirSync(join(work, "scripts"));
  for (const script of ["wiki-overlay.sh", "wiki-sync.sh"])
    cpSync(join(repo, "scripts", script), join(work, "scripts", script));
  await git(work, "add", "-A");
  await git(work, "commit", "-q", "-m", "ci: the Wiki mechanism");
  await git(work, "push", "-q", "origin", "main");

  const show = async (gitDir: string, ref: string, name: string) => {
    const result = await run(root, "git", "--git-dir", gitDir, "show", `${ref}:${name}`);
    return result.status === 0 ? result.stdout : undefined;
  };
  let n = 0; // merged PRs
  let k = 0; // scratch folders

  return {
    root,
    work,
    async pr(name, files) {
      await git(work, "checkout", "-q", "-b", name, "main");
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(work, path)), { recursive: true });
        writeFileSync(join(work, path), content);
      }
      await git(work, "add", "-A");
      await git(work, "commit", "-q", "-m", `feat: ${name}`);
      await git(work, "push", "-q", "origin", name);
      await git(work, "checkout", "-q", "main");
    },
    async merge(name) {
      await git(work, "checkout", "-q", "main");
      await git(work, "merge", "-q", "--squash", name);
      await git(work, "commit", "-q", "-m", `feat: ${name} (#${String(++n)})`);
      await git(work, "push", "-q", "origin", "main");
    },
    async tree(name) {
      // the checkout of a pull_request run: main's tip merged with the PR head (HEAD^1 = main)
      const ci = join(root, `ci-${name}-${String(++k)}`);
      await git(root, "clone", "-q", "--branch", "main", codeGit, ci);
      await git(ci, "fetch", "-q", "origin", name);
      await git(ci, "merge", "-q", "--no-ff", "-m", "merge", `origin/${name}`);
      // the shared Wiki = docs/wiki-pending, exported without .git
      const dir = join(root, `tree-${name}-${String(k)}`);
      mkdirSync(dir);
      const archive = join(root, `shared-${String(k)}.tar`);
      await git(root, "--git-dir", codeGit, "archive", "-o", archive, "docs/wiki-pending");
      await run(root, "tar", "-xf", archive, "-C", dir);
      const overlay = await run(ci, "scripts/wiki-overlay.sh", "apply", dir, "HEAD^1");
      return { dir, overlay };
    },
    async sync(extra = {}) {
      const checkout = join(root, `sync-${String(++k)}`);
      await git(root, "clone", "-q", "--branch", "main", codeGit, checkout);
      return runProcess("scripts/wiki-sync.sh", [], {
        cwd: checkout,
        env: { ...env, WIKI_URL: wikiGit, REPO_URL: codeGit, ...extra },
      });
    },
    wikiPage: (name) => show(wikiGit, "master", name),
    pendingPage: (name) => show(codeGit, "docs/wiki-pending", name),
    async wikiLog() {
      const log = await git(root, "--git-dir", wikiGit, "log", "--format=%s", "master");
      return log.split("\n");
    },
    wikiHead: () => git(root, "--git-dir", wikiGit, "rev-parse", "master"),
    pendingHead: () => git(root, "--git-dir", codeGit, "rev-parse", "docs/wiki-pending"),
  };
}

const read = (dir: string, name: string): string | undefined => {
  try {
    return readFileSync(join(dir, name), "utf8");
  } catch {
    return undefined;
  }
};

let h: Harness;
beforeEach(async () => {
  h = await harness();
});

// each test makes a few repos and runs git ~30 times; the compile checks run tsc
describe("#1026: a PR's Wiki pages travel with it", { timeout: 120_000 }, () => {
  it("AC1: a PR's Wiki is the shared one plus its own pages only", async () => {
    await h.pr("pr1", {
      "wiki/Alpha.md": page("Alpha", "v1"),
      "wiki/Gamma.md": page("Gamma"),
      "src/a.ts": "a",
    });
    await h.pr("pr2", { "wiki/Beta.md": page("Beta", "v2"), "src/b.ts": "b" });
    await h.pr("pr3", { "src/c.ts": "no pages" });

    const one = await h.tree("pr1");
    const two = await h.tree("pr2");
    const three = await h.tree("pr3");

    expect(one.overlay.status).toBe(0);
    expect(read(one.dir, "Alpha.md")).toBe(page("Alpha", "v1"));
    expect(read(one.dir, "Gamma.md")).toBe(page("Gamma"));
    expect(read(one.dir, "Beta.md")).toBe(page("Beta", "v0")); // pr2's page is nowhere in pr1's check
    expect(read(two.dir, "Beta.md")).toBe(page("Beta", "v2"));
    expect(read(two.dir, "Alpha.md")).toBe(page("Alpha", "v0"));
    expect(read(two.dir, "Gamma.md")).toBeUndefined();
    expect(read(three.dir, "Alpha.md")).toBe(page("Alpha", "v0")); // no pages of its own: the shared Wiki
    expect(read(three.dir, "Old.md")).toBeUndefined(); // wiki/Old.md is in main, not in this change
    expect(three.overlay.stdout).toContain("no Wiki pages of its own");
  });

  it("AC1: a page that does not compile fails only its own PR", async () => {
    await h.pr("broken", { "wiki/Alpha.md": page("Alpha", bad) });
    await h.pr("fine", { "wiki/Beta.md": page("Beta", good) });
    const broken = await h.tree("broken");
    const fine = await h.tree("fine");

    const failed = await checkWiki(h.root, broken.dir);
    const passed = await checkWiki(h.root, fine.dir);

    expect(failed.status).toBe(1);
    expect(failed.stderr).toMatch(/Alpha\.md:\d+: TS2322/);
    expect(passed.status).toBe(0);
    expect(passed.stdout).toContain("references and links exist");
  });

  it("AC1: only flat .md pages are overlaid", async () => {
    await h.pr("nested", { "wiki/sub/Page.md": page("Page") });
    await h.pr("image", { "wiki/logo.png": "x" });

    for (const name of ["nested", "image"]) {
      const { overlay } = await h.tree(name);
      expect(overlay.status).toBe(1);
      expect(overlay.stderr).toContain("only flat wiki/<Page>.md files");
    }
  });

  type Pr = "pr1" | "pr2";
  const mine: Record<Pr, { file: string; title: string; text: string }> = {
    pr1: { file: "Alpha.md", title: "Alpha", text: page("Alpha", "v1") },
    pr2: { file: "Beta.md", title: "Beta", text: page("Beta", "v2") },
  };
  it.each<[Pr, Pr]>([
    ["pr1", "pr2"],
    ["pr2", "pr1"],
  ])("AC2: two PRs on different pages, merged %s then %s", async (first, second) => {
    const old = (pr: Pr) => page(mine[pr].title, "v0");
    for (const pr of ["pr1", "pr2"] as const)
      await h.pr(pr, { [`wiki/${mine[pr].file}`]: mine[pr].text });
    const before = await h.pendingHead();

    // while both are open the shared branch holds neither page
    expect(await h.pendingPage("Alpha.md")).toBe(old("pr1"));
    expect(await h.pendingPage("Beta.md")).toBe(old("pr2"));

    await h.merge(first);
    // merged into main, not yet published: nothing moved early, and the other PR's check is unchanged
    expect(await h.pendingHead()).toBe(before);
    const waiting = await h.tree(second);
    expect(read(waiting.dir, mine[second].file)).toBe(mine[second].text);
    expect(read(waiting.dir, mine[first].file)).toBe(old(first));

    expect((await h.sync()).status).toBe(0);
    expect(await h.pendingPage(mine[first].file)).toBe(mine[first].text);
    expect(await h.pendingPage(mine[second].file)).toBe(old(second)); // still unpublished
    expect(await h.pendingPage("Old.md")).toBeUndefined();

    await h.merge(second);
    expect((await h.sync()).status).toBe(0);
    expect(await h.wikiPage("Alpha.md")).toBe(mine.pr1.text);
    expect(await h.wikiPage("Beta.md")).toBe(mine.pr2.text);
    expect(await h.pendingHead()).toBe(await h.wikiHead());
    expect((await h.wikiLog()).slice(0, 2)).toEqual([
      `docs: feat: ${second} (#2)`,
      `docs: feat: ${first} (#1)`,
    ]);
  });

  it("AC2: two merges, one Sync run", async () => {
    await h.pr("pr1", { "wiki/Alpha.md": page("Alpha", "v1") });
    await h.pr("pr2", { "wiki/Beta.md": page("Beta", "v2") });
    await h.merge("pr1");
    await h.merge("pr2");

    expect((await h.sync()).status).toBe(0);

    expect(await h.wikiPage("Alpha.md")).toBe(page("Alpha", "v1"));
    expect(await h.wikiPage("Beta.md")).toBe(page("Beta", "v2"));
    expect(await h.wikiPage("Old.md")).toBeUndefined(); // before the script was added: not ours
    expect((await h.wikiLog()).slice(0, 3)).toEqual([
      "docs: feat: pr2 (#2)",
      "docs: feat: pr1 (#1)",
      "seed",
    ]);
  });

  it("AC2: the same page in two PRs conflicts in git, so the second is rebased and rechecked", async () => {
    await h.pr("pr1", { "wiki/Alpha.md": page("Alpha", "from pr1") });
    await h.pr("pr2", { "wiki/Alpha.md": page("Alpha", "from pr2") });
    await h.merge("pr1");

    await expect(h.merge("pr2")).rejects.toThrow(/CONFLICT/);
  });

  it("AC3: Sync publishes the merged pages exactly once", async () => {
    await h.pr("pr1", { "wiki/Alpha.md": page("Alpha", "v1") });
    await h.merge("pr1");

    const first = await h.sync();
    const head = await h.wikiHead();
    const again = await h.sync();

    expect(first.status).toBe(0);
    expect(first.stdout).toContain("Published the Wiki pages of");
    expect(await h.pendingPage("Alpha.md")).toBe(page("Alpha", "v1"));
    expect(await h.pendingHead()).toBe(head);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("nothing to publish");
    expect(await h.wikiHead()).toBe(head);
    const body = await git(
      h.root,
      "--git-dir",
      join(h.root, "wiki.git"),
      "log",
      "-1",
      "--format=%B",
      "master",
    );
    expect(body).toMatch(/Wiki-Overlay-Source: [0-9a-f]{40}/);
  });

  it("AC3: a later edit of the page in the Wiki is not undone by a rerun", async () => {
    await h.pr("pr1", { "wiki/Alpha.md": page("Alpha", "v1") });
    await h.merge("pr1");
    await h.sync();
    // a direct edit after the publish (scripts/wiki.sh publish): Wiki and branch both move
    const clone = join(h.root, "direct");
    await git(h.root, "clone", "-q", join(h.root, "wiki.git"), clone);
    writeFileSync(join(clone, "Alpha.md"), page("Alpha", "v2 by hand"));
    await git(clone, "commit", "-q", "-am", "hand edit");
    await git(clone, "push", "-q", "origin", "HEAD:master");
    await git(clone, "push", "-q", join(h.root, "code.git"), "HEAD:refs/heads/docs/wiki-pending");

    expect((await h.sync()).status).toBe(0);

    expect(await h.wikiPage("Alpha.md")).toBe(page("Alpha", "v2 by hand"));
  });

  it("AC3: a direct publish ahead of the branch is built on, and the branch catches up", async () => {
    await h.pr("pr1", { "wiki/Alpha.md": page("Alpha", "v1") });
    await h.merge("pr1");
    const clone = join(h.root, "direct");
    await git(h.root, "clone", "-q", join(h.root, "wiki.git"), clone);
    writeFileSync(join(clone, "Home.md"), page("Home", "edited"));
    await git(clone, "commit", "-q", "-am", "direct publish");
    await git(clone, "push", "-q", "origin", "HEAD:master"); // the shared branch stays behind

    expect((await h.sync()).status).toBe(0);

    expect(await h.wikiPage("Home.md")).toBe(page("Home", "edited"));
    expect(await h.wikiPage("Alpha.md")).toBe(page("Alpha", "v1"));
    expect(await h.pendingHead()).toBe(await h.wikiHead());
  });

  it("AC3: diverged Wiki and branch stop the sync without a push", async () => {
    await h.pr("pr1", { "wiki/Alpha.md": page("Alpha", "v1") });
    await h.merge("pr1");
    const clone = join(h.root, "direct");
    await git(h.root, "clone", "-q", join(h.root, "wiki.git"), clone);
    writeFileSync(join(clone, "Home.md"), page("Home", "web UI edit"));
    await git(clone, "commit", "-q", "-am", "web edit");
    await git(clone, "push", "-q", "origin", "HEAD:master");
    await git(clone, "reset", "-q", "--hard", "HEAD~1");
    writeFileSync(join(clone, "Beta.md"), page("Beta", "pending edit"));
    await git(clone, "commit", "-q", "-am", "pending edit");
    await git(
      clone,
      "push",
      "-q",
      "-f",
      join(h.root, "code.git"),
      "HEAD:refs/heads/docs/wiki-pending",
    );
    const head = await h.wikiHead();

    const result = await h.sync();

    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain("diverged");
    expect(await h.wikiHead()).toBe(head);
    expect(await h.wikiPage("Alpha.md")).toBe(page("Alpha", "v0"));
  });

  it("AC3: a half-finished publish is completed, not repeated", async () => {
    await h.pr("pr1", { "wiki/Alpha.md": page("Alpha", "v1") });
    await h.merge("pr1");
    const behind = await h.pendingHead();
    await h.sync();
    const head = await h.wikiHead();
    const commits = (await h.wikiLog()).length;
    // the crash: the Wiki was pushed, the branch was not
    await git(
      h.root,
      "--git-dir",
      join(h.root, "code.git"),
      "update-ref",
      "refs/heads/docs/wiki-pending",
      behind,
    );

    const result = await h.sync();

    expect(result.status).toBe(0);
    expect(await h.wikiHead()).toBe(head);
    expect((await h.wikiLog()).length).toBe(commits);
    expect(await h.pendingHead()).toBe(head);
  });

  it("AC3: a main commit whose pages the Wiki already holds still advances the marker", async () => {
    await h.pr("pr1", { "wiki/Alpha.md": page("Alpha", "v1") });
    await h.merge("pr1");
    // the same text published by hand before Sync ran
    const clone = join(h.root, "direct");
    await git(h.root, "clone", "-q", join(h.root, "wiki.git"), clone);
    writeFileSync(join(clone, "Alpha.md"), page("Alpha", "v1"));
    await git(clone, "commit", "-q", "-am", "by hand");
    await git(clone, "push", "-q", "origin", "HEAD:master");
    await git(clone, "push", "-q", join(h.root, "code.git"), "HEAD:refs/heads/docs/wiki-pending");
    await h.sync();
    writeFileSync(join(clone, "Alpha.md"), page("Alpha", "v3 later by hand"));
    await git(clone, "commit", "-q", "-am", "later");
    await git(clone, "pull", "-q", "--rebase", "origin", "master");
    await git(clone, "push", "-q", "origin", "HEAD:master");
    await git(clone, "push", "-q", join(h.root, "code.git"), "HEAD:refs/heads/docs/wiki-pending");

    await h.sync();

    expect(await h.wikiPage("Alpha.md")).toBe(page("Alpha", "v3 later by hand"));
  });
});
