/**
 * #630: a test of this package never runs a child process synchronously. `spawnSync`,
 * `execFileSync` and `execSync` hold the vitest fork's event loop; held 60 s, the fork's pending
 * `onTaskUpdate` to vitest times out, its run rejects, and vitest 3's forks pool skips the
 * `singleFork` fault suite whole (run 41261656814). `tests/helpers/process.ts` awaits instead.
 */
import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

/** The `no-restricted-syntax` findings for `code` as a test file of this package (an existing one: the typed lint needs it in the project). */
async function findings(code: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: root });
  const [result] = await eslint.lintText(code, {
    filePath: `${root}packages/agboss/tests/package.test.ts`,
  });
  return (result?.messages ?? [])
    .filter((message) => message.ruleId === "no-restricted-syntax")
    .map((message) => message.message);
}

describe("#630: no synchronous child process in packages/agboss's tests", () => {
  it.each([
    ['import { spawnSync } from "node:child_process";\nspawnSync("node");\n'],
    ['import { execFileSync } from "node:child_process";\nexecFileSync("git");\n'],
    ['import { execSync as run } from "child_process";\nrun("ls");\n'],
    ['import * as childProcess from "node:child_process";\nchildProcess.spawnSync("node");\n'],
  ])(
    "%s is a lint error naming the fault suite and the helper",
    async (code) => {
      const found = await findings(code);

      expect(found).toHaveLength(1);
      expect(found[0]).toContain("tests/helpers/process.ts");
      expect(found[0]).toContain("#630");
    },
    60_000,
  );

  it("the awaited spawn, and the names in a string, pass", async () => {
    const code =
      'import { spawn } from "node:child_process";\nspawn("node");\nexport const s = "spawnSync(\\"npm\\")";\n';

    expect(await findings(code)).toEqual([]);
  }, 60_000);

  it("a faked interrupt is still refused there (the rule's list kept, #180)", async () => {
    expect(await findings('const e = new Error("x");\ne.name = "GraphInterrupt";\n')).toHaveLength(
      1,
    );
  }, 60_000);
});
