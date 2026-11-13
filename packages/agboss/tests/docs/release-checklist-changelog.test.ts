/**
 * #981 (fix-forward, D3): the RELEASE_CHECKLIST's `release_branch` and `assemble_changelog` really cut
 * `release/$RELEASE_VERSION` (from the prepared chore branch, else main) and fold the fragments in, and
 * Step 2 and the satellites' Step 6 call them. The functions run in a scratch clone.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../helpers/process.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repo = new URL("../../../../", import.meta.url).pathname;
const checklist = readFileSync(join(repo, "RELEASE_CHECKLIST.md"), "utf8");
const functions = checklist.slice(
  checklist.indexOf("release_branch() {"),
  checklist.indexOf("```", checklist.indexOf("assemble_changelog() {")),
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

  it("cut it from the prepared chore/691-version branch when origin has one", async () => {
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
    expect(readFileSync(join(work, "bump.txt"), "utf8")).toBe("0.3.0\n");
    expect(
      await git(work, "rev-parse --abbrev-ref release/0.3.0@{upstream} || true"),
    ).not.toContain("chore/691");
  });

  it("Step 2 and the satellites' Step 6 call both, the pushed branch is release/*", async () => {
    const core = step("## Step 2", "## Step 3");
    expect(core).toContain("release_branch");
    expect(core).toContain('assemble_changelog ""');
    const postgres = step("## Step 6", "## Step 7");
    expect(postgres).toContain("release_branch");
    expect(postgres).toContain('assemble_changelog "agbossjs/agboss"');
    expect(postgres).not.toContain('git switch "release/');
    expect(checklist).toContain("chore/691-version-<version>");
  });
});
