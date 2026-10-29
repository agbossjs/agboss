/**
 * #470: the shipped skills teach the layout by kind — one entity per file in its kind folder,
 * errors, repositories, schemas and SQL apart from services — and their own snippets keep to it:
 * every file a snippet writes sits in the folder of its kind, no TypeScript snippet holds DDL,
 * interpolated SQL, a `new XDto()` or a `StepFailedError` subclass.
 *
 * #474: every skill file shows one class per file and names it (`file=`), at a path of the layout
 * SKILL.md states and `agboss generate` writes — `src/[<domain>/]<kind>/…`, a workflow with its
 * starts and finishes in `workflows/<w>/`, a prompt-bearing component in `<kind>/<n>/`, DTOs in
 * `dto/`, tests mirroring `src/` — and `examples/flow-patterns` keeps to it with its real files. The
 * rules live in layout-rules.ts.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repo, scratch } from "./docs-check.js";
import {
  KINDS,
  MAX_FILE_LINES,
  PROMPT_KINDS,
  classWithoutFileOf,
  domainOf,
  forbiddenOf,
  layoutOf,
  oneEntityOf,
  placementOf,
  promptFolderOf,
  shapeOf,
  snippetsOf,
  testMirrorOf,
  workflowPlacementOf,
  type Placed,
  type ProjectFiles,
  type Snippet,
  type Violation,
} from "./layout-rules.js";

const SKILLS = join(repo, "packages/agboss/skills/agboss");

const skillFiles: readonly string[] = [
  "SKILL.md",
  ...readdirSync(join(SKILLS, "references")).map((name) => `references/${name}`),
];
const textOf = (name: string): string => readFileSync(join(SKILLS, name), "utf8");
const snippetsByFile: ReadonlyMap<string, readonly Snippet[]> = new Map(
  skillFiles.map((name) => [name, snippetsOf(name, textOf(name))]),
);
const shipped: readonly Snippet[] = [...snippetsByFile.values()].flat();

/** The files one skill file's snippets write: each skill file is one project (check:docs, #196). */
const filesOf = (snippets: readonly Snippet[]): ProjectFiles =>
  new Set(snippets.flatMap((snippet) => (snippet.file === undefined ? [] : [snippet.file])));

/** Every layout rule over every snippet of every skill file, each in its own file's project. */
const shippedLayout = (): Violation[] =>
  [...snippetsByFile.values()].flatMap((snippets) =>
    snippets.flatMap((snippet) => layoutOf(snippet, filesOf(snippets))),
  );

/** One snippet of a made-up file, for the rules' own tests. */
const sample = (lang: string, file: string | undefined, body: string): Snippet => ({
  where: "x.md:1",
  lang,
  file,
  body,
});
const at = (file: string): Placed => ({ where: "x.md:1", file });
const projectOf = (...files: readonly string[]): ProjectFiles => new Set(files);

/** Every file under `root`'s `folders`, relative to `root`, as `/`-paths (no node_modules). */
function treeOf(root: string, folders: readonly string[]): string[] {
  return folders.flatMap((folder) =>
    readdirSync(join(root, folder), { withFileTypes: true, recursive: true })
      .filter((entry) => entry.isFile() && !entry.parentPath.includes("node_modules"))
      .map((entry) => relative(root, join(entry.parentPath, entry.name)).split("\\").join("/")),
  );
}

/** The layout rules over a real folder's files, each named by the folder. */
function treeLayoutOf(where: string, files: readonly string[]): Violation[] {
  const project = projectOf(...files);
  return files.flatMap((file) => layoutOf({ where, file }, project));
}

describe("#470: the layout rules find what they guard against", () => {
  it.each([
    ["src/a/services/order.repository.ts", "services/ holds only *.service.ts"],
    ["src/a/services/order-not-found.error.ts", "*.error.ts belongs in errors/"],
    ["src/a/services/loans.services.ts", "services/ holds only *.service.ts"],
    ["src/a/dtos/order.dto.ts", "*.dto.ts belongs in dto/"],
    ["src/a/order.dto.ts", "*.dto.ts belongs in dto/"],
    ["src/a/a2a/key-directory.service.ts", "*.service.ts belongs in services/"],
    ["src/a/schema/order.schema.ts", "*.schema.ts belongs in schemas/"],
    ["src/a/migrations/orders.sql", "*.sql belongs in sql/"],
    ["src/a/sql/orders.ts", "sql/ holds only *.sql"],
    ["tests/a/services/order.repository.test.ts", "services/ holds only *.service.ts"],
  ])("%s: %s", (file, why) => {
    expect(placementOf(sample("ts", file, "")).join("\n")).toContain(why);
  });

  it.each([
    "src/a/services/order.service.ts",
    "src/a/repositories/order.repository.ts",
    "src/a/errors/order-not-found.error.ts",
    "src/a/schemas/order.schema.ts",
    "src/a/dto/order.dto.ts",
    "src/a/sql/orders.sql",
    "src/a/agents/support/support.agent.ts",
    "tests/a/services/order.service.test.ts",
    "tests/a/dto/order.dto.test.ts",
  ])("%s is where its kind belongs", (file) => {
    expect(placementOf(sample("ts", file, ""))).toEqual([]);
  });

  it.each([
    ["db.exec(`CREATE TABLE notes (id TEXT)`);", "DDL in TypeScript"],
    ["db.prepare(`SELECT * FROM notes WHERE ${clause}`);", "string-interpolated SQL"],
    ['db.exec(`DELETE FROM notes WHERE id = "${id}"`);', "string-interpolated SQL"],
    ["return new OrderDto();", "a DTO built with new"],
    ["return Object.assign(new Order(), value);", "a DTO built with new"],
    ["export class LostError extends StepFailedError {}", "a StepFailedError subclass"],
    ['import { openSqliteDatabase } from "x";', "an internal SQLite helper"],
    ['import { x } from "@agboss/core/internal";', "@agboss/core/internal"],
  ])("TypeScript `%s`: %s", (body, why) => {
    expect(forbiddenOf(sample("ts", undefined, body)).join("\n")).toContain(why);
  });

  it("SQL itself and parameterised statements are fine", () => {
    expect(
      forbiddenOf(sample("sql", "src/a/sql/notes.sql", "CREATE TABLE notes (id TEXT);")),
    ).toEqual([]);
    expect(
      forbiddenOf(
        sample("ts", undefined, 'db.prepare("SELECT * FROM notes WHERE id = ?").get(id);'),
      ),
    ).toEqual([]);
  });

  it("two classes, or a file over 200 lines, is not one entity", () => {
    const two = sample("ts", "src/a/dto/a.dto.ts", "export class ADto {}\nexport class BDto {}\n");
    const long = sample("ts", "src/a/x.ts", "\n".repeat(MAX_FILE_LINES + 1));

    expect(oneEntityOf(two).join("\n")).toContain("2 classes");
    expect(oneEntityOf(long).join("\n")).toContain(`${String(MAX_FILE_LINES + 2)} lines`);
    expect(oneEntityOf(sample("ts", "src/a/dto/a.dto.ts", "export class ADto {}\n"))).toEqual([]);
  });
});

describe("#470: the shipped skills keep to the layout they teach", () => {
  it("there are snippets to check, and files for each kind of #470", () => {
    const files = [...filesOf(shipped)];

    expect(shipped.length).toBeGreaterThan(150);
    for (const folder of ["services", "repositories", "errors", "schemas", "dto", "sql"])
      expect(
        files.some((file) => file.split("/").at(-2) === folder),
        folder,
      ).toBe(true);
  });

  it("AC1: every file a snippet writes is in the folder of its kind", () => {
    expect(shipped.flatMap(placementOf)).toEqual([]);
  });

  it("AC1, AC2: no snippet holds DDL, interpolated SQL, new DTOs, StepFailedError subclasses or internals", () => {
    expect(shipped.flatMap(forbiddenOf)).toEqual([]);
  });

  it("AC1: the folders of #470 are listed in SKILL.md's layout rule", () => {
    const skill = textOf("SKILL.md");

    for (const path of [
      "errors/<name>.error.ts",
      "repositories/<name>.repository.ts",
      "schemas/<name>.schema.ts",
      "sql/<name>.sql",
      "services/<name>.service.ts",
      "dto/<name>.dto.ts",
    ])
      expect(skill, path).toContain(path);
  });
});

describe("#474: the layout rules find what they guard against", () => {
  it("AC4: two classes in one block are named by the skill file, line and file", () => {
    const two = sample("ts", "src/a/dto/a.dto.ts", "export class ADto {}\nexport class BDto {}\n");

    expect(oneEntityOf(two)).toEqual(["x.md:1 src/a/dto/a.dto.ts: 2 classes"]);
  });

  it.each([
    ["export abstract class", "export abstract class A {}\nexport class B {}\n"],
    ["export default class", "export default class A {}\nexport class B {}\n"],
  ])("AC4: `%s` counts as a class", (_kind, body) => {
    expect(oneEntityOf(sample("ts", "src/a/services/a.service.ts", body))).toEqual([
      "x.md:1 src/a/services/a.service.ts: 2 classes",
    ]);
  });

  it("AC4: a class with exported functions and constants is one class", () => {
    const body = "export class ADto {}\nexport function aOf(): void {}\nexport const A = 1;\n";

    expect(oneEntityOf(sample("ts", "src/a/dto/a.dto.ts", body))).toEqual([]);
  });

  it("AC4: a class that is not exported is not counted", () => {
    const body = "class Helper {}\nexport class ADto {}\n";

    expect(oneEntityOf(sample("ts", "src/a/dto/a.dto.ts", body))).toEqual([]);
  });

  it.each(["sql", "yaml", "md", "json"])(
    "AC4: a %s block is ignored by the class rules",
    (lang) => {
      const body = "export class A {}\nexport class B {}\n";

      expect(oneEntityOf(sample(lang, "src/a/sql/a.sql", body))).toEqual([]);
      expect(classWithoutFileOf(sample(lang, undefined, body))).toEqual([]);
    },
  );

  it("AC4: a ts block declaring an exported class without file= is named by its line", () => {
    expect(classWithoutFileOf(sample("ts", undefined, "export class OrderDto {}\n"))).toEqual([
      "x.md:1: an exported class without file= — name the file it lives in",
    ]);
  });

  it("AC4: a ts block with file=, or without a class, needs nothing more", () => {
    const flow = "export const paths = [start(A).toFinish(B)] as const;\n";

    expect(classWithoutFileOf(sample("ts", "src/dto/a.dto.ts", "export class ADto {}"))).toEqual(
      [],
    );
    expect(classWithoutFileOf(sample("ts", undefined, flow))).toEqual([]);
  });

  it.each([
    [
      "src/a/workflow-starts/chat.workflow-start.ts",
      "*.workflow-start.ts belongs in workflows/<w>/",
    ],
    [
      "src/a/workflow-finishes/chat.workflow-finish.ts",
      "*.workflow-finish.ts belongs in workflows/<w>/",
    ],
    ["src/a/desk.workflow.ts", "*.workflow.ts belongs in workflows/<w>/"],
    ["src/workflows/desk.workflow.ts", "*.workflow.ts belongs in workflows/<w>/"],
    ["src/desk/chat.workflow-start.ts", "*.workflow-start.ts belongs in workflows/<w>/"],
    [
      "src/workflows/desk/support.workflow.ts",
      "a workflow is named after its folder — workflows/desk/desk.workflow.ts",
    ],
    [
      "src/workflows/desk/order.dto.ts",
      "workflows/<w>/ holds only its *.workflow.ts, *.workflow-start.ts and *.workflow-finish.ts",
    ],
  ])("AC4: %s — %s", (file, why) => {
    expect(workflowPlacementOf(at(file))).toEqual([`x.md:1 ${file}: ${why}`]);
  });

  it.each([
    "src/workflows/desk/desk.workflow.ts",
    "src/workflows/desk/chat.workflow-start.ts",
    "src/workflows/desk/hand-over.workflow-finish.ts",
    "src/billing/workflows/refund/refund.workflow.ts",
    "offers/src/workflows/offer/offer.workflow.ts",
    "tests/workflows/desk/desk.workflow.test.ts",
    "legacy/support.workflow.ts",
  ])("AC4: %s is a workflow file where it belongs (or outside the rule)", (file) => {
    expect(workflowPlacementOf(at(file))).toEqual([]);
  });

  it.each(Object.entries(PROMPT_KINDS))(
    "AC4: a flat %s file is not in its component's folder",
    (kind, suffix) => {
      const file = `src/a/${kind}/main${suffix}`;

      expect(promptFolderOf(at(file), projectOf(file))).toEqual([
        `x.md:1 ${file}: a ${kind} component lives in ${kind}/<n>/<n>${suffix}`,
      ]);
    },
  );

  it.each(Object.entries(PROMPT_KINDS))("AC4: %s/<n>/<n>%s is its folder", (kind, suffix) => {
    const file = `src/a/${kind}/main/main${suffix}`;

    expect(promptFolderOf(at(file), projectOf(file))).toEqual([]);
  });

  it.each([
    ["src/agents/billing/refund.agent.ts", "a agents component lives in agents/<n>/<n>.agent.ts"],
    ["src/a/billing/billing.agent.ts", "a agents component lives in agents/<n>/<n>.agent.ts"],
    ["src/agents/billing/billing.tool.ts", "agents/<n>/ holds only its *.agent.ts and *.prompt.md"],
    ["src/agents/helpers.ts", "agents/ holds one folder per component"],
  ])("AC4: %s — %s", (file, why) => {
    expect(promptFolderOf(at(file), projectOf(file))).toEqual([`x.md:1 ${file}: ${why}`]);
  });

  it.each([
    ["agents/support/support.prompt.md", "agents/support/support.agent.ts"],
    ["compactions/notes/notes.prompt.md", "compactions/notes/notes.compaction.ts"],
    ["routers/main/main.prompt.md", "routers/main/main.router.ts"],
  ])("AC4: a .prompt.md beside its component is fine (%s)", (prompt, component) => {
    const files = projectOf(`src/desk/${prompt}`, `src/desk/${component}`);

    expect(promptFolderOf(at(`src/desk/${prompt}`), files)).toEqual([]);
  });

  it.each([
    ["src/desk/agents/support.prompt.md", "src/desk/agents/support.agent.ts"],
    ["src/desk/agents/support/support.prompt.md", "src/desk/agents/support/other.agent.ts"],
    ["src/desk/prompts/support/support.prompt.md", "src/desk/agents/support/support.agent.ts"],
    ["src/desk/agents/other/support.prompt.md", "src/desk/agents/support/support.agent.ts"],
  ])("AC4: a .prompt.md elsewhere is not beside its component (%s)", (prompt, component) => {
    const violations = promptFolderOf(at(prompt), projectOf(prompt, component));

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(
      new RegExp(`^x\\.md:1 ${prompt}: a \\*\\.prompt\\.md sits beside its component — no `),
    );
  });

  it.each([
    ["src/desk/loose.ts", "src/desk/ is a domain — it holds only kind folders"],
    ["src/desk/desk.application.ts", "*.application.ts stays at the src/ root"],
    ["src/desk/environments/app.environment.ts", "environments/ stays at the src/ root"],
    [
      "src/desk/billing/agents/refund/refund.agent.ts",
      "src/desk/billing/ is not a kind folder — one domain level holds kind folders",
    ],
    [
      "src/desk/infra/json.logger.ts",
      "src/desk/infra/ is not a kind folder — one domain level holds kind folders",
    ],
    ["src/main.ts", "src/ holds kind folders and *.application.ts only"],
  ])("AC4: a domain with a loose file or a stranger — %s", (file, why) => {
    expect(domainOf(at(file))).toEqual([`x.md:1 ${file}: ${why}`]);
  });

  it.each([
    "src/shop.application.ts",
    "src/environments/app.environment.ts",
    "src/billing/agents/refund/refund.agent.ts",
    "src/billing/workflows/refund/refund.workflow.ts",
    "src/agents/refund/refund.agent.ts",
    "src/dto/order.dto.ts",
    "src/dto/nested/order.dto.ts",
    "offers/src/offers.application.ts",
    "tests/billing/loose.test.ts",
    "legacy/support.graph.ts",
  ])("AC4: %s keeps to one domain level (a kind-named folder is a kind)", (file) => {
    expect(domainOf(at(file))).toEqual([]);
  });

  it("AC4: every kind folder may be a domain's", () => {
    const files = [...KINDS]
      .filter((kind) => kind !== "environments")
      .map((kind) => `src/billing/${kind}/x.ts`);

    expect(files.flatMap((file) => domainOf(at(file)))).toEqual([]);
  });

  const SRC: ProjectFiles = projectOf(
    "src/services/api.service.ts",
    "src/credit/workflows/credit/credit.workflow.ts",
    "src/credit/routers/limit/limit.router.ts",
    "offers/src/workflows/offer/offer.workflow.ts",
  );
  const withTest = (file: string): ProjectFiles => new Set([...SRC, file]);

  it.each([
    "tests/services/api.service.test.ts",
    "tests/credit/routers/limit/limit.router.test.ts",
    "tests/credit/workflows/credit/credit.workflow.test.ts",
    "tests/credit/workflows/credit/credit-crash.test.ts",
    "tests/credit/workflows/credit/support/credit-crash.ts",
    "tests/credit/workflows/credit/__snapshots__/lookup.cassette.json",
    "tests/credit/routers/support/scripts.ts",
    "offers/tests/workflows/offer/offer.workflow.test.ts",
  ])("AC4: %s mirrors src/", (file) => {
    expect(testMirrorOf(at(file), withTest(file))).toEqual([]);
  });

  const MIRROR =
    "a test mirrors src/ — tests/x/y.test.ts tests src/x/y.ts, or sits in tests/…/workflows/<w>/";
  const HELPER = "a test helper sits in support/ or __snapshots__/ of a folder that mirrors src/";

  it.each([
    ["tests/credit.test.ts", MIRROR],
    ["tests/services/missing.service.test.ts", MIRROR],
    ["tests/credit/workflows/other/other.workflow.test.ts", MIRROR],
    ["tests/credit/workflows/credit/deep/credit.workflow.test.ts", MIRROR],
    ["offers/tests/workflows/credit/credit.workflow.test.ts", MIRROR],
    ["tests/support/credit-crash.ts", HELPER],
    ["tests/__snapshots__/lookup.cassette.json", HELPER],
    ["tests/credit/helper.ts", HELPER],
    ["tests/billing/support/helper.ts", HELPER],
  ])("AC4: a test outside the mirror — %s", (file, why) => {
    expect(testMirrorOf(at(file), withTest(file))).toEqual([`x.md:1 ${file}: ${why}`]);
  });

  it("AC4: a source file is not a test's business", () => {
    expect(testMirrorOf(at("src/loose.ts"), projectOf("src/loose.ts"))).toEqual([]);
  });

  it("AC2: the shape of a path drops names, the project folder and the domain level", () => {
    expect(shapeOf("src/billing/agents/refund/refund.agent.ts")).toBe(
      "src/agents/<n>/<n>.agent.ts",
    );
    expect(shapeOf("offers/src/workflows/offer/offer.workflow.ts")).toBe(
      "src/workflows/<n>/<n>.workflow.ts",
    );
    expect(shapeOf("src/dto/order.dto.ts")).toBe("src/dto/<n>.dto.ts");
    expect(shapeOf("src/shop.application.ts")).toBe("src/<n>.application.ts");
    expect(shapeOf("tests/desk/workflows/desk/desk.workflow.test.ts")).toBe(
      "tests/workflows/<n>/<n>.workflow.test.ts",
    );
    expect(shapeOf("legacy/support.graph.ts")).toBeUndefined();
  });

  it("AC4: layoutOf runs every placement rule at once", () => {
    const files = [
      "src/desk/dtos/order.dto.ts",
      "src/desk/workflow-starts/chat.workflow-start.ts",
      "src/desk/agents/support.agent.ts",
      "src/desk/desk.application.ts",
      "tests/desk.test.ts",
    ];

    const found = treeLayoutOf("x", files);

    expect(found).toEqual([
      "x src/desk/dtos/order.dto.ts: *.dto.ts belongs in dto/",
      "x src/desk/dtos/order.dto.ts: src/desk/dtos/ is not a kind folder — one domain level holds kind folders",
      "x src/desk/workflow-starts/chat.workflow-start.ts: *.workflow-start.ts belongs in workflows/<w>/",
      "x src/desk/workflow-starts/chat.workflow-start.ts: src/desk/workflow-starts/ is not a kind folder — one domain level holds kind folders",
      "x src/desk/agents/support.agent.ts: a agents component lives in agents/<n>/<n>.agent.ts",
      "x src/desk/desk.application.ts: *.application.ts stays at the src/ root",
      `x tests/desk.test.ts: ${MIRROR}`,
    ]);
  });
});

describe("#474: the shipped skills keep to the layout", () => {
  it("AC1: every reference 01–13 and SKILL.md has files to check", () => {
    for (const [name, snippets] of snippetsByFile)
      if (name !== "references/11-cli-studio-and-error-catalog.md")
        expect(filesOf(snippets).size, name).toBeGreaterThan(0);
    expect(skillFiles).toHaveLength(14);
  });

  it("AC1: every skill file shows one class per file, each under 200 lines", () => {
    expect(shipped.flatMap(oneEntityOf)).toEqual([]);
  });

  it("AC1: every class block names its file", () => {
    expect(shipped.flatMap(classWithoutFileOf)).toEqual([]);
  });

  it("AC1: workflows and prompt-bearing components in their folders, one domain level, tests mirroring src", () => {
    expect(shippedLayout()).toEqual([]);
  });

  it("AC1: SKILL.md allows one domain level and no longer condenses", () => {
    const skill = textOf("SKILL.md").replace(/\s+/g, " ");

    expect(skill).toContain("`src/billing/agents/refund/refund.agent.ts`");
    expect(skill).toContain("one domain level");
    for (const name of skillFiles) expect(textOf(name), name).not.toMatch(/condense/i);
  });

  it("AC1: every kind folder the check knows is named in SKILL.md's layout rule", () => {
    const skill = textOf("SKILL.md");

    for (const kind of KINDS) expect(skill, kind).toContain(`\`${kind}/`);
    for (const [kind, suffix] of Object.entries(PROMPT_KINDS))
      expect(skill, kind).toContain(`${kind}/<name>/<name>${suffix}`);
  });
});

const EXAMPLE = join(repo, "examples/flow-patterns");

describe("#474: examples/flow-patterns keeps to the layout", () => {
  const files = treeOf(EXAMPLE, ["src", "tests"]);

  it("AC3: its src/ and tests/ keep to every placement rule", () => {
    expect(files.length).toBeGreaterThan(200);
    expect(treeLayoutOf("examples/flow-patterns", files)).toEqual([]);
  });

  it("AC3: its DTOs are in dto/, each workflow with its starts and finishes in workflows/<name>/", () => {
    const folders = new Set(files.flatMap((file) => file.split("/").slice(0, -1)));

    for (const old of ["dtos", "workflow-starts", "workflow-finishes", "health", "pii"])
      expect(folders.has(old), old).toBe(false);
    expect(files).toContain("src/credit/workflows/credit/credit.workflow.ts");
    expect(files).toContain("src/credit/workflows/credit/credit.workflow-start.ts");
    expect(files).toContain("src/credit/agents/approval/approval.agent.ts");
    expect(files).toContain("src/credit/dto/credit-order.dto.ts");
  });

  it("AC3: every domain of src/ holds only kind folders, and has a workflow", () => {
    const domains = new Set(
      files.flatMap((file) => {
        const [root, first = ""] = file.split("/");
        return root === "src" && !KINDS.has(first) && !first.endsWith(".ts") ? [first] : [];
      }),
    );

    expect(domains.size).toBeGreaterThanOrEqual(12);
    for (const domain of domains)
      expect(
        files.some((file) => file.startsWith(`src/${domain}/workflows/`)),
        domain,
      ).toBe(true);
  });

  it("AC3: its tests mirror src/ — no test left at the tests/ root", () => {
    const tests = files.filter((file) => file.startsWith("tests/"));

    expect(tests.filter((file) => file.split("/").length === 2)).toEqual([]);
    expect(tests.filter((file) => file.endsWith(".test.ts")).length).toBeGreaterThan(19);
  });
});

/** `agboss …` of the built CLI in `cwd`. */
function agboss(cwd: string, args: readonly string[]): void {
  const cli = join(repo, "packages/agboss-cli/bin/agboss.js");
  const done = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
  expect(done.status, `${args.join(" ")}\n${done.stdout}${done.stderr}`).toBe(0);
}

describe("#474: the snippets' layout is the one agboss generate writes", () => {
  const dir = scratch();
  const project = join(dir, "shop");
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A project as `agboss create` writes it, then a workflow with an agent, a router and a tool. */
  const generated = (): string[] => {
    agboss(dir, [
      "create",
      "shop",
      "--yes",
      "--skip-install",
      "--agents",
      "triage-agent:Sorts requests",
    ]);
    agboss(project, ["generate", "workflow", "refund-workflow"]);
    agboss(project, ["generate", "agent", "billing-agent", "--workflow", "refund-workflow"]);
    agboss(project, ["generate", "router", "escalation-router", "--workflow", "refund-workflow"]);
    agboss(project, [
      "generate",
      "tool",
      "refund-tool",
      "--workflow",
      "refund-workflow",
      "--agent",
      "billing-agent",
    ]);
    return treeOf(project, ["src", "tests"]);
  };
  let files: readonly string[] = [];
  beforeAll(() => {
    files = generated();
  }, 120_000);

  it("AC2: generate writes a workflow folder, an agent folder and a tool", () => {
    expect(files).toEqual(
      expect.arrayContaining([
        "src/workflows/refund/refund.workflow.ts",
        "src/workflows/refund/text.workflow-start.ts",
        "src/agents/billing/billing.agent.ts",
        "src/agents/billing/billing.prompt.md",
        "src/routers/escalation/escalation.router.ts",
        "src/tools/refund.tool.ts",
        "tests/workflows/refund/refund.workflow.test.ts",
      ]),
    );
  });

  it("AC2: what generate writes passes the rules the snippets pass", () => {
    expect(treeLayoutOf("agboss generate", files)).toEqual([]);
  });

  it("AC2: every folder and file name generate writes is one a snippet shows", () => {
    const shown = new Set(shipped.flatMap((snippet) => shapeOf(snippet.file) ?? []));
    const written = new Set(files.flatMap((file) => shapeOf(file) ?? []));

    expect([...written].filter((shape) => !shown.has(shape))).toEqual([]);
  });
});

/** The rules each skill file must state, by acceptance criterion. */
const STATED: readonly (readonly [string, string, readonly string[]])[] = [
  [
    "AC1",
    "SKILL.md",
    [
      "`services/` holds **only** `*.service.ts`",
      "`AGBossError` subclass in `errors/<name>.error.ts`",
      "never a `StepFailedError`",
      "never `new OrderDto()`",
      "under 200 lines",
      "one class per",
    ],
  ],
  [
    "AC1",
    "references/01-composition-and-architecture.md",
    [
      "`services/` holds **only** `*.service.ts`",
      "`errors/<name>.error.ts`",
      "`repositories/<name>.repository.ts`",
      "`schemas/<name>.schema.ts`",
      "`sql/<name>.sql`",
      "One class per file",
      "`Object.assign(new X(), …)`",
    ],
  ],
  [
    "AC1",
    "references/03-components-di-and-lifecycle.md",
    [
      "`repositories/<name>.repository.ts`",
      "`AGBossError` subclass (`errors/<name>.error.ts`)",
      "never a `StepFailedError`",
      "static override readonly code",
    ],
  ],
  [
    "AC2",
    "SKILL.md",
    [
      "never inline `CREATE TABLE`",
      "never string-interpolated SQL",
      "`sqliteConnection.database`",
      "listed in `@Application({ providers })`, never a workflow's",
      "`sqliteConnection.transaction(() => …)`",
      "no `await` inside",
    ],
  ],
  [
    "AC2",
    "references/09-persistence-k8s-and-deploy.md",
    [
      "`SqliteConnection`",
      "never an internal helper",
      "Both are listed in `@Application({ providers })` — `SqliteConnection` too",
      "`ensureSchema`",
      "`?` parameters",
      "never build queries with string interpolation",
      "Drizzle ORM",
      "`BEGIN IMMEDIATE` write lock across an `await`",
      "`testWith(App, { instances: 2 })`",
    ],
  ],
  [
    "AC3",
    "references/01-composition-and-architecture.md",
    ["`*.prompt.md`", "`sql/*.sql`", "`[prompt.missing-file]`"],
  ],
  [
    "AC3",
    "references/09-persistence-k8s-and-deploy.md",
    [
      "`[prompt.missing-file]`",
      "`executionContext.step.idempotencyKey`",
      "monotonic fencing token",
      "`ExecutionLeaseLostError`",
      "every 30 s",
      "`@Application({ maxConcurrentSteps })`",
      "once its 30 s lease expires",
      "`SqliteChildExecutionQueueRepository`",
    ],
  ],
];

describe("#470: the skills state the rules", () => {
  it.each(STATED.flatMap(([ac, file, phrases]) => phrases.map((phrase) => [ac, file, phrase])))(
    "%s: %s says %s",
    (_ac, file, phrase) => {
      expect(textOf(file).replace(/\s+/g, " ")).toContain(phrase);
    },
  );
});
