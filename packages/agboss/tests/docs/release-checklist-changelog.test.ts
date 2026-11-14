/**
 * #981 (fix-forward, D3): the RELEASE_CHECKLIST's `release_branch`, `assemble_changelog` and
 * `bump_version` really cut `release/$RELEASE_VERSION` (always from main), fold the fragments in and
 * bump the version; every one of them stops a `&&` chain when a command inside fails (bash turns
 * `set -e` off there); Step 2 and the satellites' Step 6 call them. They run in a scratch clone.
 *
 * #1044: the blocks themselves are walked, pasted verbatim out of the checklist, in scratch clones
 * (pushes, `gh`, `make` and the npm steps are shims; everything else runs for real) with the old
 * chore branches on origin: Step 2 for the core, Step 6 and Step 7 for postgres, mongodb and redis —
 * and a failure injected at every command (the Nth command exits 7): the block exits non-zero and
 * nothing after that command runs, `git push` and `gh pr create` included.
 */
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../helpers/process.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

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

// ---------------------------------------------------------------------------------------------
// #1044: the checklist's blocks, pasted, in scratch clones, with a failure injected at every command

/** Every external command a block runs; each is a shim that counts, logs, can fail, and stubs the public ones. */
const TOOLS = [
  "git",
  "node",
  "npm",
  "gh",
  "make",
  "sed",
  "grep",
  "cat",
  "mktemp",
  "rm",
  "realpath",
  "date",
];

const SHIM = `#!/bin/bash
tool=$(basename "$0")
real=$(<"$F1044_DIR/real.$tool")
if [ -n "\${F1044_IN:-}" ]; then exec "$real" "$@"; fi
n=$(( $(<"$F1044_DIR/count") + 1 ))
echo "$n" > "$F1044_DIR/count"
echo "$n $tool $*" >> "$F1044_DIR/log"
if [ "$n" = "\${F1044_FAIL_AT:-0}" ]; then exit 7; fi
export F1044_IN=1
case "$tool $1 $2" in
  "git push"*) exit 0 ;;
  "npm ci"*|"npm run"*|"npm view"*|"npm pack"*|make*) exit 0 ;;
  "gh pr list"*) echo 0; exit 0 ;;
  "gh pr create"*) echo https://example.test/pull/1; exit 0 ;;
  "gh run list"*) echo 12345; exit 0 ;;
  "gh run"*) exit 0 ;;
esac
exec "$real" "$@"
`;

const bashBlocks = (text: string): string[] =>
  [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
const prelude = (bashBlocks(checklist.slice(checklist.indexOf("All commands start with")))[0] ?? "")
  .replace(/^export WORKSPACE_ROOT=.*$/m, 'export WORKSPACE_ROOT="$F1044_ROOT"')
  .replace(/^export RELEASE_VERSION=.*$/m, 'export RELEASE_VERSION="0.3.0"')
  .replace(/^export SCRATCH=.*$/m, 'export SCRATCH="$F1044_ROOT/scratch"');
const step2 = bashBlocks(step("## Step 2", "## Step 3"))[0] ?? "";
const [step6Prep = "", step6Tag = ""] = bashBlocks(step("## Step 6", "## Step 7"));

const CARS = {
  agboss: { name: "core", dir: "agboss" },
  postgres: { name: "@agboss/postgres", dir: "postgres" },
  mongodb: { name: "@agboss/mongodb", dir: "mongodb" },
  redis: { name: "@agboss/redis", dir: "redis" },
} as const;
type Car = keyof typeof CARS;

const README: Record<Car, string> = {
  agboss: "# core\n",
  postgres: "# @agboss/postgres\n\nPostgreSQL stores.\n\n## Install\n",
  mongodb:
    "# @agboss/mongodb\n\n> Status: every store contract of the core. Each passes the\n> core's `storeConformance` and the fault suite against a real\n> replica set ([Tests](#tests)). Not published to npm yet.\n\n## Install\n",
  redis:
    "# @agboss/redis\n\nRedis coordination stores.\nPostgreSQL or MongoDB (agbossjs/agboss#527).\n\n> Not published to npm yet: it ships with the 0.1.1 release.\n\n## The stores\n",
};

let template: string;
let shimDir: string;
const real: Record<string, string> = {};
const envOf = (root: string, failAt: number) => ({
  ...process.env,
  RELEASE_VERSION: "0.3.0",
  F1044_ROOT: root,
  F1044_DIR: join(root, "shim"),
  F1044_FAIL_AT: String(failAt),
  PATH: `${join(root, "shim", "bin")}:${process.env.PATH ?? ""}`,
  AGBOSS_POSTGRES_TEST_URL: "postgres://scratch",
  TMPDIR: tmpdir(),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  ...Object.fromEntries(
    ["AUTHOR", "COMMITTER"].flatMap((who) => [
      [`GIT_${who}_NAME`, "t"],
      [`GIT_${who}_EMAIL`, "t@t"],
    ]),
  ),
});
const plain = (cwd: string, script: string) =>
  runProcess("bash", ["-c", `set -euo pipefail\n${script}`], {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });
const gitIn = async (cwd: string, args: string): Promise<void> => {
  const r = await plain(cwd, `git -c user.name=t -c user.email=t@t ${args}`);
  expect(r.status, r.stderr).toBe(0);
};

async function makeCar(car: Car, dir: string): Promise<void> {
  const work = join(template, dir);
  await gitIn(template, `init -q --bare origin/${dir}.git`);
  await gitIn(template, `clone -q origin/${dir}.git ${dir}`);
  for (const sub of ["scripts/release", "changes"]) mkdirSync(join(work, sub), { recursive: true });
  for (const name of ["changelog-assemble.mjs", "changelog-fold.mjs"]) {
    writeFileSync(join(work, "scripts", name), readFileSync(join(repo, "scripts", name)));
  }
  writeFileSync(
    join(work, "scripts/release/release-plan.mjs"),
    'console.log("v" + process.argv[3].replace(/^.*v/, "") + ": planned");\n',
  );
  writeFileSync(
    join(work, "scripts/pin-framework.mjs"),
    'import { writeFileSync } from "node:fs";\n' +
      'writeFileSync(".agboss-version.json", JSON.stringify({ source: "registry", version: process.argv[3] }) + "\\n");\n',
  );
  writeFileSync(join(work, ".agboss-version.json"), '{"source":"sha","version":"abc"}\n');
  writeFileSync(join(work, "changes", "config.json"), '{ "issuePrefix": "#" }\n');
  writeFileSync(
    join(work, "changes", "7-bug.md"),
    "---\nsection: Fixed\nissue: 7\n---\n\n**Bug** (#7)\n",
  );
  writeFileSync(
    join(work, "CHANGELOG.md"),
    "# Changelog\n\n## [0.3.0] — unreleased\n\n### Fixed\n\n- **Old** (#1)\n",
  );
  writeFileSync(join(work, "README.md"), README[car]);
  const pkg = car === "agboss" ? "packages/agboss" : ".";
  mkdirSync(join(work, pkg), { recursive: true });
  writeFileSync(
    join(work, pkg, "package.json"),
    JSON.stringify({
      name: car === "agboss" ? "@agboss/core" : CARS[car].name,
      version: car === "agboss" ? "0.3.0" : "0.2.0",
    }) + "\n",
  );
  if (car !== "agboss") {
    await plain(work, "npm install --package-lock-only --ignore-scripts --no-audit --no-fund");
  }
  await gitIn(work, "add -A");
  await gitIn(work, "commit -q -m main");
  await gitIn(work, "push -q origin HEAD:main");
  // the old prepared chore branch (#691), superseded: its edits conflict with main and date the section early
  await gitIn(work, "switch -q -c chore");
  writeFileSync(
    join(work, "CHANGELOG.md"),
    "# Changelog\n\n## [0.3.0] — 2026-11-05\n\n### Fixed\n\n- **Old** (#1)\n- **Bug** (#7)\n",
  );
  writeFileSync(join(work, "chore.txt"), "prepared\n");
  await gitIn(work, "add -A");
  await gitIn(work, "commit -q -m chore");
  await gitIn(work, "push -q origin chore:chore/691-version-0.3.0");
  await gitIn(work, "switch -q main");
  await gitIn(work, "branch -q -D chore");
  await gitIn(work, "remote set-url origin ../origin/" + dir + ".git");
}

beforeAll(async () => {
  for (const tool of TOOLS) {
    const r = await plain(repo, `command -v ${tool}`);
    real[tool] = r.stdout.trim();
  }
  template = mkdtempSync(join(tmpdir(), "checklist-walk-"));
  mkdirSync(join(template, "origin"));
  for (const [car, { dir }] of Object.entries(CARS) as [Car, (typeof CARS)[Car]][]) {
    await makeCar(car, dir);
  }
  shimDir = join(template, "shim");
  mkdirSync(join(shimDir, "bin"), { recursive: true });
  for (const tool of TOOLS) {
    writeFileSync(join(shimDir, "bin", tool), SHIM);
    chmodSync(join(shimDir, "bin", tool), 0o755);
    writeFileSync(join(shimDir, `real.${tool}`), real[tool] ?? "");
  }
}, 120_000);
afterAll(() => {
  rmSync(template, { recursive: true, force: true });
});

interface Walk {
  readonly status: number | null;
  readonly log: string[];
  readonly root: string;
  readonly stderr: string;
}
/** Paste `block` (after the prelude) in a fresh copy of the scratch clones; the `failAt`th command exits 7. */
async function walk(block: string, failAt: number, pre = ""): Promise<Walk> {
  const root = mkdtempSync(join(tmpdir(), "checklist-run-"));
  cpSync(template, root, { recursive: true });
  writeFileSync(join(root, "shim", "count"), "0");
  writeFileSync(join(root, "shim", "log"), "");
  const run = await runProcess("bash", ["-c", `${prelude}\n${pre}\n${block}`], {
    cwd: root,
    env: envOf(root, failAt),
  });
  const log = readFileSync(join(root, "shim", "log"), "utf8")
    .split("\n")
    .filter(Boolean);
  return { status: run.status, log, root, stderr: run.stderr };
}

const forCar = (block: string, car: Car): string =>
  block
    .replaceAll("$WORKSPACE_ROOT/postgres", `$WORKSPACE_ROOT/${car}`)
    .replaceAll("agbossjs/postgres", `agbossjs/${car}`);

/** A failure at each of the block's `total` commands: non-zero, and the command was the last one run. */
async function everyFailureStops(block: string, total: number, pre = ""): Promise<void> {
  const points = Array.from({ length: total }, (_, i) => i + 1);
  for (let i = 0; i < points.length; i += 4) {
    const batch = await Promise.all(points.slice(i, i + 4).map((n) => walk(block, n, pre)));
    batch.forEach((w, j) => {
      const n = points[i + j] ?? 0;
      expect(w.status, `failure at command ${String(n)}: ${w.log[n - 1] ?? ""}`).not.toBe(0);
      expect(w.log, `nothing runs after command ${String(n)}: ${w.log.join(" ; ")}`).toHaveLength(
        n,
      );
      rmSync(w.root, { recursive: true, force: true });
    });
  }
}

const subjects = async (root: string, car: Car): Promise<string[]> => {
  const r = await plain(
    join(root, CARS[car].dir),
    "git log --format=%s origin/main..release/0.3.0",
  );
  return r.stdout.trim().split("\n").reverse();
};
const readIn = (root: string, car: Car, file: string): string =>
  readFileSync(join(root, CARS[car].dir, file), "utf8");

describe("#1044: Step 2 and Step 6 + Step 7, pasted in scratch clones", () => {
  it("has the blocks it walks", () => {
    expect(step2).toContain("open_release_pr agbossjs/agboss || exit 1");
    expect(step6Prep).toContain("drop_unpublished_note");
    expect(step6Tag).toContain("watch_release_run agbossjs/postgres || exit 1");
    expect(prelude).toContain("drop_unpublished_note() {");
  });

  it("every block of the checklist ends its chains in `|| exit 1` or has no chain after which a line runs", () => {
    for (const block of bashBlocks(checklist)) {
      const lines = block.split("\n");
      lines.forEach((line, i) => {
        if (i === 0 || /^\s/.test(line) || !line.includes(" && ")) return;
        // the first line of a chain: the chain's last line must carry `|| exit 1`
        let end = i;
        while (/\\$/.test(lines[end] ?? "")) end += 1;
        expect(lines[end], line).toMatch(/\|\| exit 1\s*$/);
      });
    }
    expect(checklist).not.toMatch(/^gh pr create|^gh run watch/m);
  });

  it("Step 2 (core) pasted: cuts release/ from main, one changelog commit, opens the PR, ignores the chore branch", async () => {
    const w = await walk(step2, 0);
    expect(w.status, w.stderr).toBe(0);
    expect(await subjects(w.root, "agboss")).toEqual(["chore(#691): changelog 0.3.0"]);
    expect(readIn(w.root, "agboss", "CHANGELOG.md")).toMatch(
      /^## \[0\.3\.0\] — \d{4}-\d{2}-\d{2}$/m,
    );
    expect(readIn(w.root, "agboss", "CHANGELOG.md")).not.toContain("2026-11-05");
    expect(existsSync(join(w.root, "agboss", "chore.txt"))).toBe(false);
    expect(w.log.some((l) => l.includes(" git push --force-with-lease origin HEAD"))).toBe(true);
    expect(w.log.some((l) => l.includes(" gh pr create -R agbossjs/agboss"))).toBe(true);
    expect(w.log.at(-1)).toContain("gh pr create");
    await everyFailureStops(step2, w.log.length);
    rmSync(w.root, { recursive: true, force: true });
  }, 240_000);

  it.each(["postgres", "mongodb", "redis"] as const)(
    "Step 6 + Step 7 (%s) pasted: changelog, version, README note, pin; PR opened; every failure stops",
    async (car) => {
      const block = forCar(step6Prep, car);
      const w = await walk(block, 0);
      expect(w.status, w.stderr).toBe(0);
      const note =
        car === "postgres"
          ? []
          : ["docs(agbossjs/agboss#691): drop the not-published note from the README"];
      expect(await subjects(w.root, car)).toEqual([
        "chore(agbossjs/agboss#691): changelog 0.3.0",
        `chore(agbossjs/agboss#691): ${CARS[car].name} 0.3.0`,
        ...note,
        "chore(agbossjs/agboss#691): pin @agboss/core 0.3.0 from npm",
      ]);
      const readme = readIn(w.root, car, "README.md");
      expect(readme).not.toContain("Not published to npm yet");
      expect(readme).not.toContain("\n\n\n");
      if (car === "mongodb")
        expect(readme).toContain("real\n> replica set ([Tests](#tests)).\n\n## Install");
      if (car === "redis") expect(readme).toContain("(agbossjs/agboss#527).\n\n## The stores");
      if (car === "postgres") expect(readme).toBe(README.postgres);
      expect(readIn(w.root, car, "CHANGELOG.md")).not.toContain("2026-11-05");
      expect(readIn(w.root, car, "CHANGELOG.md")).toContain("- **Old** (#1)\n- **Bug** (#7)\n");
      expect(JSON.parse(readIn(w.root, car, "package.json")).version).toBe("0.3.0");
      expect(JSON.parse(readIn(w.root, car, ".agboss-version.json")).source).toBe("registry");
      expect(existsSync(join(w.root, CARS[car].dir, "chore.txt"))).toBe(false);
      expect((await plain(join(w.root, CARS[car].dir), "git status --porcelain")).stdout).toBe("");
      expect(w.log.at(-1)).toContain(`gh pr create -R agbossjs/${car}`);
      await everyFailureStops(block, w.log.length);
      rmSync(w.root, { recursive: true, force: true });
    },
    600_000,
  );

  it("a rerun of Step 6 + Step 7 on the existing release branch adds no commit", async () => {
    const w = await walk(forCar(step6Prep, "redis"), 0);
    expect(w.status, w.stderr).toBe(0);
    const again = await runProcess("bash", ["-c", `${prelude}\n${forCar(step6Prep, "redis")}`], {
      cwd: w.root,
      env: envOf(w.root, 0),
    });
    expect(again.status, again.stderr).toBe(0);
    expect(await subjects(w.root, "redis")).toHaveLength(4);
    rmSync(w.root, { recursive: true, force: true });
  }, 120_000);

  it("Step 6's tag block (postgres) pasted: tags the merged main, watches the run; every failure stops", async () => {
    const w = await walk(step6Tag, 0);
    expect(w.status, w.stderr).toBe(0);
    expect(w.log.some((l) => l.includes(" git tag -a postgres-v0.3.0"))).toBe(true);
    expect(w.log.at(-1)).toContain("gh run watch -R agbossjs/postgres 12345");
    await everyFailureStops(step6Tag, w.log.length);
    rmSync(w.root, { recursive: true, force: true });
  }, 240_000);
});
