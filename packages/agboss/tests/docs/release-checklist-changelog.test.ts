/**
 * #981 (fix-forward, D3): the RELEASE_CHECKLIST's `release_branch`, `assemble_changelog` and
 * `bump_version` really cut `release/$RELEASE_VERSION` (always from main), fold the fragments in and
 * bump the version; every one of them stops a `&&` chain when a command inside fails (bash turns
 * `set -e` off there); Step 2 and the satellites' Step 6 call them. They run in a scratch clone.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../helpers/process.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repo = new URL("../../../../", import.meta.url).pathname;
const checklist = readFileSync(join(repo, "RELEASE_CHECKLIST.md"), "utf8");
const functions = checklist.slice(
  checklist.indexOf("release_branch() {"),
  checklist.indexOf("```", checklist.indexOf("bump_version() {")),
);
const step = (from: string, to: string): string =>
  checklist.slice(checklist.indexOf(from), checklist.indexOf(to));

let dir: string;
const sh = (cwd: string, script: string) =>
  runProcess("bash", ["-c", `set -euo pipefail\n${script}`], {
    cwd,
    env: {
      ...process.env,
      RELEASE_VERSION: "0.3.0",
      GIT_CONFIG_GLOBAL: "/dev/null",
      ...Object.fromEntries(
        ["AUTHOR", "COMMITTER"].flatMap((who) => [
          [`GIT_${who}_NAME`, "t"],
          [`GIT_${who}_EMAIL`, "t@t"],
        ]),
      ),
    },
  });
const git = async (cwd: string, args: string): Promise<string> => {
  const r = await sh(cwd, `git -c user.name=t -c user.email=t@t ${args}`);
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "checklist-"));
  await git(dir, "init -q --bare origin.git");
  await git(dir, "clone -q origin.git work");
  const work = join(dir, "work");
  mkdirSync(join(work, "scripts"));
  mkdirSync(join(work, "changes"));
  for (const name of ["changelog-assemble.mjs", "changelog-fold.mjs"]) {
    writeFileSync(join(work, "scripts", name), readFileSync(join(repo, "scripts", name)));
  }
  writeFileSync(join(work, "changes", "config.json"), '{ "issuePrefix": "#" }\n');
  writeFileSync(
    join(work, "CHANGELOG.md"),
    "# Changelog\n\n## [0.3.0] — unreleased\n\n### Fixed\n\n- **Old** (#1)\n",
  );
  writeFileSync(
    join(work, "changes", "7-bug.md"),
    "---\nsection: Fixed\nissue: 7\n---\n\n**Bug** (#7)\n",
  );
  await git(work, "add -A");
  await git(work, "commit -q -m main");
  await git(work, "push -q origin HEAD:main");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("D3: the checklist's release branch and changelog commands", async () => {
  it("cut release/$RELEASE_VERSION from main and assemble the unreleased section", async () => {
    const work = join(dir, "work");
    const r = await sh(
      work,
      `${functions}\nrelease_branch && assemble_changelog "agbossjs/agboss"`,
    );
    expect(r.status, r.stderr).toBe(0);
    expect(await git(work, "branch --show-current")).toBe("release/0.3.0");
    expect(await git(work, "log -1 --format=%s")).toBe(
      "chore(agbossjs/agboss#691): changelog 0.3.0",
    );
    const changelog = readFileSync(join(work, "CHANGELOG.md"), "utf8");
    expect(changelog).toMatch(/^## \[0\.3\.0\] — \d{4}-\d{2}-\d{2}$/m);
    expect(changelog).toContain("- **Old** (#1)\n- **Bug** (#7)\n");
    expect(await git(work, "status --porcelain")).toBe("");
    // a rerun is safe: nothing to commit
    const again = await sh(work, `${functions}\nrelease_branch && assemble_changelog ""`);
    expect(again.status, again.stderr).toBe(0);
    expect((await git(work, "log --oneline origin/main..HEAD")).split("\n")).toHaveLength(1);
  });

  it("cut it from main even when origin has a prepared chore/691-version branch", async () => {
    const work = join(dir, "work");
    await git(work, "switch -q -c prepared");
    writeFileSync(join(work, "bump.txt"), "0.3.0\n");
    await git(work, "add -A");
    await git(work, "commit -q -m bump");
    await git(work, "push -q origin prepared:chore/691-version-0.3.0");
    await git(work, "switch -q main");
    const r = await sh(work, `${functions}\nrelease_branch`);
    expect(r.status, r.stderr).toBe(0);
    expect(await git(work, "branch --show-current")).toBe("release/0.3.0");
    expect(existsSync(join(work, "bump.txt"))).toBe(false);
    expect(await git(work, "rev-parse HEAD")).toBe(await git(work, "rev-parse origin/main"));
  });

  it("a failed git fetch stops the chain: release_branch returns non-zero, nothing after it runs", async () => {
    const work = join(dir, "work");
    const branch = await git(work, "branch --show-current");
    await git(work, "remote set-url origin /nonexistent/origin.git");
    const r = await sh(work, `${functions}\nrelease_branch && touch ran`);
    expect(r.status).not.toBe(0);
    expect(existsSync(join(work, "ran"))).toBe(false);
    expect(await git(work, "branch --show-current")).toBe(branch);
  });

  it("a failed assemble stops the chain, commits nothing and leaves the fragments", async () => {
    const work = join(dir, "work");
    writeFileSync(join(work, "changes", "7-bug.md"), "---\nsection: Nope\nissue: 7\n---\n\nx #7\n");
    const r = await sh(work, `${functions}\nassemble_changelog "" && touch ran`);
    expect(r.status).not.toBe(0);
    expect(existsSync(join(work, "ran"))).toBe(false);
    expect(await git(work, "log --oneline origin/main..HEAD")).toBe("");
    expect(existsSync(join(work, "changes", "7-bug.md"))).toBe(true);
  });

  it("a released section for the version stops the chain too (nothing is silently skipped)", async () => {
    const work = join(dir, "work");
    writeFileSync(join(work, "CHANGELOG.md"), "# Changelog\n\n## [0.3.0] — 2026-01-01\n\n- x\n");
    const r = await sh(work, `${functions}\nrelease_branch && assemble_changelog "" && touch ran`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("already has a section for 0.3.0");
    expect(existsSync(join(work, "ran"))).toBe(false);
  });

  it("a failed commit stops the chain", async () => {
    const work = join(dir, "work");
    const hook = join(work, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const r = await sh(work, `${functions}\nrelease_branch && assemble_changelog "" && touch ran`);
    expect(r.status).not.toBe(0);
    expect(existsSync(join(work, "ran"))).toBe(false);
  });

  it("bump_version sets package.json and the lockfile, commits once, and a rerun is a no-op", async () => {
    const work = join(dir, "work");
    writeFileSync(join(work, "package.json"), '{ "name": "@agboss/x", "version": "0.2.0" }\n');
    await sh(work, "npm install --package-lock-only --ignore-scripts --no-audit --no-fund");
    await git(work, "add -A");
    await git(work, "commit -q -m pkg");
    await git(work, "push -q origin HEAD:main");
    const r = await sh(work, `${functions}\nrelease_branch && bump_version && bump_version`);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(work, "package.json"), "utf8")).version).toBe("0.3.0");
    expect(JSON.parse(readFileSync(join(work, "package-lock.json"), "utf8")).version).toBe("0.3.0");
    expect(await git(work, "log -1 --format=%s")).toBe(
      "chore(agbossjs/agboss#691): @agboss/x 0.3.0",
    );
    expect((await git(work, "log --oneline origin/main..HEAD")).split("\n")).toHaveLength(1);
  });

  it("bump_version without a package.json stops the chain", async () => {
    const work = join(dir, "work");
    const r = await sh(work, `${functions}\nbump_version && touch ran`);
    expect(r.status).not.toBe(0);
    expect(existsSync(join(work, "ran"))).toBe(false);
  });

  it("Step 2 and the satellites' Step 6 call both, the pushed branch is release/*", async () => {
    const core = step("## Step 2", "## Step 3");
    expect(core).toContain("release_branch");
    expect(core).toContain('assemble_changelog ""');
    const postgres = step("## Step 6", "## Step 7");
    expect(postgres).toContain("release_branch");
    expect(postgres).toContain('assemble_changelog "agbossjs/agboss"');
    expect(postgres).toContain("bump_version");
    expect(postgres).not.toContain('git switch "release/');
    expect(functions).not.toContain("origin/chore");
    expect(checklist).toContain("superseded");
  });
});
