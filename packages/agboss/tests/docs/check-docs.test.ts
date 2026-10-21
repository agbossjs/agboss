/**
 * #196 AC1: a doc snippet that does not compile — or a script, npm script or `agboss` command a doc
 * mentions that does not exist — fails `npm run check` (scripts/check-docs.mjs, run after the build).
 */
import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { checkDocs, scratch, writeDocs } from "./docs-check.js";

const dirs: string[] = [];
const check = (docs: Readonly<Record<string, string>>) => {
  const dir = scratch();
  dirs.push(dir);
  return checkDocs(dir, writeDocs(dir, docs));
};

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const fence = (info: string, ...lines: string[]): string =>
  ["```" + info, ...lines, "```"].join("\n");

const router = [
  'import { DecidedBy, Router } from "agboss";',
  'import { WorkflowStartTextDto } from "agboss/dto";',
  "class Answer {}",
  "",
  '@Router({ name: "main-router", description: "Picks", decidedBy: DecidedBy.Model, input: { message: WorkflowStartTextDto }, routes: [ROUTE] })',
  "export class MainRouter {}",
];

// each test runs tsc (or vitest) over a generated project: slower than 5 s on CI runners
describe("#196 AC1: docs that compile", { timeout: 60_000 }, () => {
  it("a snippet that does not compile fails the check, naming the doc line and the TS error", () => {
    const stale = router.map((line) => line.replace("ROUTE", 'route(Answer, "Done")'));
    const result = check({ "guide.md": `# Guide\n\n${fence("ts", ...stale)}\n` });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("guide.md:8: TS2552 Cannot find name 'route'.");
  });

  it("the same snippet written against the current API passes", () => {
    const current = router.map((line) =>
      line.replace("ROUTE", '{ prompt: "Done", target: Answer }'),
    );
    const result = check({ "guide.md": `# Guide\n\n${fence("ts", ...current)}\n` });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("docs ok: 1 snippets compiled in 1 docs");
  });

  it("a fragment compiles inside its hidden snippet-context; file= snippets import each other", () => {
    const markdown = [
      fence("ts file=src/answer.ts", "export class Answer {}"),
      "",
      "<!-- snippet-context",
      'import { DecidedBy, Router } from "agboss"; import { WorkflowStartTextDto } from "agboss/dto";',
      'import { Answer } from "./src/answer.js";',
      '@Router({ name: "main-router", description: "Picks", decidedBy: DecidedBy.Model, input: { message: WorkflowStartTextDto }, routes: [',
      "// @snippet",
      "] })",
      "export class MainRouter {}",
      "-->",
      "",
      fence("ts", '{ prompt: "Done", target: Answer },'),
      "",
    ].join("\n");

    expect(check({ "guide.md": markdown }).status).toBe(0);
    expect(check({ "guide.md": markdown.replace("target: Answer", "to: Answer") }).stderr).toMatch(
      // @Router is overloaded by decidedBy (#280): the model router's overload names the field
      /guide\.md:15: TS2769 [^]*'to' does not exist in type 'ChosenRouterRoute'/,
    );
  });

  it("an opt-out needs a reason", () => {
    // one call per line (#289): the flow lint reads opted-out snippets too
    const bare = check({ "guide.md": fence("ts no-check", "route(A)", "  .to(B)") + "\n" });
    const reasoned = check({
      "guide.md": fence("ts no-check: pseudo-code, the shape only", "route(A)", "  .to(B)") + "\n",
    });

    expect(bare.status).toBe(1);
    expect(bare.stderr).toContain("guide.md:1: `no-check` needs a reason");
    expect(reasoned.status).toBe(0);
  });

  it("a script, npm script or agboss command a doc mentions must exist", () => {
    const markdown = [
      "Run `scripts/check-old-names.sh`, then `npm run test:routers`.",
      "Approve with `agb resume <id> --approve`, validate with `agboss check --nope`.",
      fence(
        "bash",
        "npx agboss g widget refund --workflow src/w.ts",
        "npx agboss chat --start chat-workflow-start",
      ),
      "Existing ones pass: `scripts/check-root.mjs`, `npm run check:docs`, `agboss check --models`, `make check`.",
      "",
    ].join("\n");
    const result = check({ "guide.md": markdown });

    expect(result.status).toBe(1);
    expect(result.stderr.trim().split("\n").slice(1)).toEqual([
      "  guide.md:1: scripts/check-old-names.sh does not exist",
      "  guide.md:1: no package has the script `npm run test:routers`",
      "  guide.md:2: unknown command `agboss resume`",
      "  guide.md:2: `agboss check` has no option --nope",
      "  guide.md:4: `agboss g widget`: expected workflow | agent | router | arbiter | tool | mcp | rag | openapi",
    ]);
  });
});
