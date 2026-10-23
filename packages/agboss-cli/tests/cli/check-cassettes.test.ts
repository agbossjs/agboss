/**
 * #395 PR 4: `agboss check --cassettes` — every `*.cassette.json` under the project compared with the
 * application's components, without running a test: a changed component is `vcr.stale-cassette`
 * (exit 3), a version 1 cassette a hint, a fresh one passes.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { envelope, fixture, agboss } from "./agboss.js";

const WORKFLOW = fixture("test-workflow/test.workflow.ts");

interface CheckResult {
  readonly checks: readonly string[];
  readonly problems: readonly { file: string; code: string; message: string }[];
}

/** A project directory holding one cassette with one recorded call of `component`. */
function projectWith(
  component: string,
  hashes: { promptHash?: string },
  version: 1 | 2 = 2,
): string {
  const cwd = mkdtempSync(join(tmpdir(), "agboss-cassettes-"));
  mkdirSync(join(cwd, "tests", "__snapshots__"), { recursive: true });
  const interaction = {
    kind: "chat",
    key: `agent:${component}`,
    request: "0",
    reply: { content: "ok" },
    ...(version === 2 ? { component, ...hashes } : {}),
  };
  writeFileSync(
    join(cwd, "tests", "__snapshots__", "run.cassette.json"),
    JSON.stringify({ version, interactions: [interaction] }),
  );
  return cwd;
}

describe("agboss check --cassettes", () => {
  it("a changed component: vcr.stale-cassette naming it and how to re-record, exit 3", async () => {
    const cwd = projectWith("coder-agent", { promptHash: "0000000000000000" });

    const call = await agboss(["check", "--cassettes", "--application", WORKFLOW, "--json"], cwd);

    expect(call.code).toBe(3);
    const result = envelope(call).result as CheckResult;
    expect(result.checks).toContain("cassettes");
    expect(result.problems).toEqual([
      {
        file: join("tests", "__snapshots__", "run.cassette.json"),
        code: "vcr.stale-cassette",
        message: expect.stringMatching(
          /^coder-agent changed since it was recorded \(prompt\) — re-record its stale interactions with AGBOSS_VCR_MODE=RECORD_STALE npm test/,
        ),
      },
    ]);
  });

  it("a version 1 cassette is a hint, not a problem; without the flag nothing is read", async () => {
    const cwd = projectWith("coder-agent", {}, 1);

    const checked = await agboss(["check", "--cassettes", "--application", WORKFLOW], cwd);
    const plain = await agboss(["check", "--application", WORKFLOW], cwd);

    expect(checked.code).toBe(0);
    expect(checked.stdout).toContain("hint: ");
    expect(checked.stdout).toContain("is a version 1 cassette");
    expect(checked.stdout).toContain("cassettes: 1 checked");
    expect(plain.code).toBe(0);
    expect(plain.stdout).not.toContain("cassettes:");
  });
});
