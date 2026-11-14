/**
 * #981: the Sync Wiki job's script (the `run:` block of sync-wiki.yml) loses no race: a Wiki that already
 * has the branch is a success, a push the Wiki refuses because it moved looks again (at most 5 attempts),
 * a diverged Wiki is never overwritten. The "Wiki" is a bare repository the block's URL is rewritten to.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../helpers/process.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repo = new URL("../../../../", import.meta.url).pathname;
const workflow = readFileSync(join(repo, ".github/workflows/sync-wiki.yml"), "utf8");
const block = workflow.slice(workflow.indexOf("run: |\n") + 7);
const script = block
  .split("\n")
  .map((line) => line.replace(/^ {10}/, ""))
  .join("\n");

let dir: string;
let wiki: string;
let pending: string;
const author = Object.fromEntries(
  ["AUTHOR", "COMMITTER"].flatMap((who) => [
    [`GIT_${who}_NAME`, "t"],
    [`GIT_${who}_EMAIL`, "t@t"],
  ]),
);
const sh = (cwd: string, command: string, extra: Record<string, string> = {}) =>
  runProcess(
    "bash",
    ["-c", `set -euo pipefail\nexport PATH="${join(dir, "bin")}:$PATH"\n${command}`],
    {
      cwd,
      env: {
        ...process.env,
        ...author,
        GIT_CONFIG_GLOBAL: "/dev/null",
        ...extra,
      },
    },
  );
const out = async (cwd: string, command: string): Promise<string> => {
  const r = await sh(cwd, command);
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
};
const commit = (name: string): Promise<string> =>
  out(
    pending,
    `echo ${name} > ${name}.md && git add -A && git commit -q -m ${name} && git rev-parse HEAD`,
  );
const wikiHead = (): Promise<string> => out(wiki, "git rev-parse master");
/** The job's block, its Wiki URL rewritten to the bare repository. */
const sync = () =>
  sh(pending, script, {
    WIKI_TOKEN: "t",
    GITHUB_REPOSITORY: "o/r",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.${wiki}.insteadOf`,
    GIT_CONFIG_VALUE_0: "https://x-access-token:t@github.com/o/r.wiki.git",
  });
const hook = (body: string): void => {
  const file = join(wiki, "hooks", "pre-receive");
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "sync-wiki-"));
  wiki = join(dir, "wiki.git");
  pending = join(dir, "pending");
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "sleep"), "#!/bin/sh\n");
  chmodSync(join(dir, "bin", "sleep"), 0o755);
  await out(dir, "git init -q --bare -b master wiki.git && git init -q -b master pending");
  await commit("a");
  await out(pending, `git push -q ${wiki} HEAD:master`);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the Sync Wiki block", () => {
  it("fast-forwards a Wiki that is behind", async () => {
    const head = await commit("b");
    const r = await sync();
    expect(r.status, r.stderr).toBe(0);
    expect(await wikiHead()).toBe(head);
  });

  it("a Wiki that already has the branch (equal or ahead) is a success and is left alone", async () => {
    expect((await sync()).status).toBe(0);
    const base = await out(pending, "git rev-parse HEAD");
    await commit("b");
    await out(pending, `git push -q ${wiki} HEAD:master && git reset -q --hard ${base}`);
    const ahead = await wikiHead();
    const r = await sync();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("nothing to publish");
    expect(await wikiHead()).toBe(ahead);
  });

  it("a push that loses a race looks again and fast-forwards", async () => {
    const middle = await commit("b");
    const last = await commit("c");
    // the first push is refused after another writer moved the Wiki to `b`
    hook(
      `if [ ! -e "${dir}/raced" ]; then touch "${dir}/raced"; git update-ref refs/heads/master ${middle}; exit 1; fi`,
    );
    const r = await sync();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("attempt 1 of 5");
    expect(await wikiHead()).toBe(last);
  });

  it("gives up after 5 attempts", async () => {
    await commit("b");
    hook("exit 1");
    const r = await sync();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("attempt 5 of 5");
    expect(r.stdout).toContain("gave up after 5 attempts");
  });

  it("a diverged Wiki (a page edited in its UI) is never overwritten", async () => {
    const base = await out(pending, "git rev-parse HEAD");
    await commit("ui");
    await out(pending, `git push -q ${wiki} HEAD:master && git reset -q --hard ${base}`);
    const edited = await wikiHead();
    await commit("b");
    const r = await sync();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("diverged");
    expect(await wikiHead()).toBe(edited);
  });
});
