/**
 * #196 AC2: a fresh agent following CLAUDE.md writes flow, router, agent and tool code that compiles
 * first time. The worked example of CLAUDE.md → Architecture (its `file=` blocks, taken from the doc
 * itself, not a copy) is typechecked against the built package, with the `.agboss/types.d.ts` its
 * workflows generate (#272), and its own test — `testWith`, models by script — runs green in a
 * project of its own.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkDocs, repo, runVitest, scratch, writeDocs } from "./docs-check.js";

const dir = scratch();
const claudeMd = readFileSync(join(repo, "CLAUDE.md"), "utf8");
const project = join(dir, "out", "CLAUDE");

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// each test runs tsc (or vitest) over a generated project: slower than 5 s on CI runners
describe("#196 AC2: the CLAUDE.md worked example", { timeout: 60_000 }, () => {
  it("typechecks against the built agboss, every block of the doc", async () => {
    const result = await checkDocs(dir, writeDocs(dir, { "CLAUDE.md": claudeMd }));

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    for (const file of [
      "src/desk/desk.workflow.ts",
      "src/desk/routers/main.router.ts",
      "src/desk/agents/support.agent.ts",
      "src/desk/agents/support.prompt.md",
      "src/desk/tools/order-status.tool.ts",
      "tests/desk.test.ts",
      ".agboss/types.d.ts",
    ])
      expect(existsSync(join(project, file)), file).toBe(true);
  });

  it("assembles and runs: its testWith test goes start → router → agent + tool → finish", async () => {
    const result = await runVitest(project);

    expect(result.stdout + result.stderr).toMatch(/Tests\s+2 passed \(2\)/);
    expect(result.status).toBe(0);
  }, 120_000);

  it("the old DSL in its place does not compile — the doc cannot drift back", async () => {
    const stale = claudeMd.replace(
      "route(SupportAgent)\n          .toFinish(ChatWorkflowFinish),",
      "route(SupportAgent)\n          .next(ChatWorkflowFinish),",
    );
    const other = scratch();
    const result = await checkDocs(other, writeDocs(other, { "CLAUDE.md": stale }));
    rmSync(other, { recursive: true, force: true });

    expect(stale).not.toBe(claudeMd);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/CLAUDE\.md:\d+: TS2339 Property 'next' does not exist/);
  });
});
