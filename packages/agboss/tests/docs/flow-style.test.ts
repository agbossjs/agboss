/**
 * #289: one call per line in flow chains. AC1 — a workflow module with `start(A).returns(B).toFinish(C)`
 * on one line fails the repo's ESLint (the `eslint .` of `make check`) with `newline-per-chained-call`;
 * the same chain one call per line passes and `make fmt` (scripts/format-flows.mjs) keeps it.
 * AC2 — a doc's flow snippet with two calls on one line fails `check:docs`, naming the doc, the line
 * and the rule; Prettier leaves the docs' code blocks alone.
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ESLint } from "eslint";
import * as prettier from "prettier";
import { afterAll, describe, expect, it } from "vitest";
import { checkDocs, repo, scratch, writeDocs } from "./docs-check.js";

const RULE = "@stylistic/newline-per-chained-call";
// linted as the in-repo example's longest workflow module (#489: flow-patterns' send-offer, job-scout's
// before): the repo's config, types and all
const WORKFLOW = join(
  repo,
  "examples/flow-patterns/src/hiring/workflows/send-offer/send-offer.workflow.ts",
);

const imports = [
  'import { start } from "@agboss/core";',
  'import { OfferRequestDto } from "../../dto/offer.dto.js";',
  'import { OfferConfirmedWorkflowFinish } from "./offer-confirmed.workflow-finish.js";',
  'import { SendOfferWorkflowStart } from "./send-offer.workflow-start.js";',
  "",
].join("\n");
const JOINED = `${imports}
export const paths = [start(SendOfferWorkflowStart).returns(OfferRequestDto).toFinish(OfferConfirmedWorkflowFinish)];
`;
const SPLIT = `${imports}
export const paths = [
  start(SendOfferWorkflowStart)
    .returns(OfferRequestDto)
    .toFinish(OfferConfirmedWorkflowFinish),
];
`;

interface FlowStyle {
  readonly FLOW_FILES: readonly string[];
}
interface FormatFlows {
  readonly formatFlow: (text: string, file: string) => Promise<string>;
}
const flowStyle = async (): Promise<FlowStyle> =>
  (await import(join(repo, "scripts/flow-style.mjs"))) as FlowStyle;
const formatFlows = async (): Promise<FormatFlows> =>
  (await import(join(repo, "scripts/format-flows.mjs"))) as FormatFlows;

const lint = async (text: string): Promise<ESLint.LintResult["messages"]> => {
  const [result] = await new ESLint({ cwd: repo }).lintText(text, { filePath: WORKFLOW });
  return result?.messages ?? [];
};

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

// ESLint with types and a spawned docs check: slower than 5 s on CI runners
describe("#289 AC1: workflow modules have one call per line", { timeout: 60_000 }, () => {
  it("a chain of three calls on one line fails the lint with newline-per-chained-call", async () => {
    const messages = await lint(JOINED);

    expect(messages.filter((m) => m.ruleId === RULE).map((m) => m.message)).toEqual([
      "Expected line break before `.returns`.",
      "Expected line break before `.toFinish`.",
    ]);
  });

  it("the same chain one call per line passes the lint", async () => {
    expect(await lint(SPLIT)).toEqual([]);
  });

  it("make fmt keeps one call per line and splits a joined chain", async () => {
    const { formatFlow } = await formatFlows();

    expect(await formatFlow(SPLIT, WORKFLOW)).toBe(SPLIT);
    expect(await formatFlow(JOINED, WORKFLOW)).toBe(SPLIT);
  });

  it("Prettier skips exactly the files the rule formats (.prettierignore = FLOW_FILES)", async () => {
    const { FLOW_FILES } = await flowStyle();
    const ignored = readFileSync(join(repo, ".prettierignore"), "utf8").split("\n");

    expect(FLOW_FILES.length).toBeGreaterThan(0);
    for (const glob of FLOW_FILES) expect(ignored).toContain(glob);
    const info = await prettier.getFileInfo(WORKFLOW, {
      ignorePath: join(repo, ".prettierignore"),
    });
    expect(info.ignored).toBe(true);
  });
});

describe("#289 AC2: docs show flow chains one call per line", { timeout: 60_000 }, () => {
  const fence = (...lines: string[]): string =>
    ["```ts no-check: a fragment", ...lines, "```"].join("\n");

  it("a flow snippet with two calls on one line fails check:docs, naming the doc, the line and the rule", async () => {
    const dir = scratch();
    dirs.push(dir);
    const doc = `# Guide\n\n${fence("export const paths = [", "  start(A).toFinish(B),", "];")}\n`;

    const result = await checkDocs(dir, writeDocs(dir, { "guide.md": doc }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `guide.md:5: Expected line break before \`.toFinish\`. (${RULE})`,
    );
  });

  it("a flow snippet one call per line, and a chain that builds no path, pass", async () => {
    const dir = scratch();
    dirs.push(dir);
    const doc = [
      "# Guide",
      "",
      fence("export const paths = [", "  start(A)", "    .toFinish(B),", "];"),
      "",
      fence('const text = ["a"].map(String).join(", ");'),
      "",
    ].join("\n");

    const result = await checkDocs(dir, writeDocs(dir, { "guide.md": doc }));

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("Prettier leaves a doc's ts block as written", async () => {
    const markdown = `# Guide\n\n${fence("export const paths = [", "  start(A)", "    .toFinish(B),", "];")}\n`;
    const options = (await prettier.resolveConfig(join(repo, "README.md"))) ?? {};

    expect(await prettier.format(markdown, { ...options, filepath: join(repo, "guide.md") })).toBe(
      markdown,
    );
  });
});
