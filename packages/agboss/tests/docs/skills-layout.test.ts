/**
 * #470: the shipped skills teach the layout by kind — one entity per file in its kind folder,
 * errors, repositories, schemas and SQL apart from services — and their own snippets keep to it:
 * every file a snippet writes sits in the folder of its kind, no TypeScript snippet holds DDL,
 * interpolated SQL, a `new XDto()` or a `StepFailedError` subclass, and SKILL.md with references 01,
 * 03 and 09 — the ones that show a project's layout — have one class per file.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repo } from "./docs-check.js";

const SKILLS = join(repo, "packages/agboss/skills/agboss");

/** A fenced block of a skill file: its language, the file it writes (if any) and its body. */
interface Snippet {
  readonly where: string;
  readonly lang: string;
  readonly file: string | undefined;
  readonly body: string;
}

/** The violation a rule found, named by its rule and where. */
type Violation = string;

const FENCE = /^```(\w+)([^\n]*)\n([\s\S]*?)^```/gm;

function snippetsOf(name: string, markdown: string): Snippet[] {
  return [...markdown.matchAll(FENCE)].map((match) => {
    const [, lang = "", info = "", body = ""] = match;
    const line = markdown.slice(0, match.index).split("\n").length;
    return { where: `${name}:${String(line)}`, lang, file: /file=(\S+)/.exec(info)?.[1], body };
  });
}

/** The kinds of #470 and the one extension each folder holds. */
const KIND_FOLDERS: Readonly<Record<string, string>> = {
  services: ".service.ts",
  repositories: ".repository.ts",
  errors: ".error.ts",
  schemas: ".schema.ts",
  dto: ".dto.ts",
  sql: ".sql",
};

/** A file in a kind folder has its kind's extension, and a file of a kind is in its folder. */
function placementOf(snippet: Snippet): Violation[] {
  const { file } = snippet;
  if (file === undefined) return [];
  const folder = file.split("/").at(-2) ?? "";
  const found: Violation[] = [];
  const own = KIND_FOLDERS[folder];
  if (own !== undefined && !file.endsWith(own))
    found.push(`${snippet.where} ${file}: ${folder}/ holds only *${own}`);
  for (const [kind, extension] of Object.entries(KIND_FOLDERS))
    if (file.endsWith(extension) && folder !== kind)
      found.push(`${snippet.where} ${file}: *${extension} belongs in ${kind}/`);
  return found;
}

/** What a TypeScript snippet never shows (#470 AC1, AC2). */
const FORBIDDEN_IN_TS: readonly (readonly [RegExp, string])[] = [
  [/\bCREATE\s+TABLE\b/i, "DDL in TypeScript — a sql/<name>.sql file"],
  [/`[^`]*\b(SELECT|INSERT|UPDATE|DELETE)\b[^`]*\$\{/i, "string-interpolated SQL — ? parameters"],
  [/\bnew \w+Dto\(|Object\.assign\(new /, "a DTO built with new — a plain object literal"],
  [/\bextends StepFailedError\b/, "a StepFailedError subclass — extend AGBossError"],
  [/\bopenSqliteDatabase\b/, "an internal SQLite helper — inject SqliteConnection"],
  [/from "@agboss\/core\/internal"/, "@agboss/core/internal — the public entries only"],
];

function forbiddenOf(snippet: Snippet): Violation[] {
  if (snippet.lang !== "ts") return [];
  return FORBIDDEN_IN_TS.filter(([pattern]) => pattern.test(snippet.body)).map(
    ([, why]) => `${snippet.where}: ${why}`,
  );
}

const MAX_FILE_LINES = 200;

/** One class per file and under 200 lines — for the skill files that show a project's layout. */
function oneEntityOf(snippet: Snippet): Violation[] {
  if (snippet.file === undefined || snippet.lang !== "ts") return [];
  const classes = snippet.body.match(/^export (?:abstract )?class /gm)?.length ?? 0;
  const lines = snippet.body.split("\n").length;
  return [
    ...(classes > 1 ? [`${snippet.where} ${snippet.file}: ${String(classes)} classes`] : []),
    ...(lines > MAX_FILE_LINES ? [`${snippet.where} ${snippet.file}: ${String(lines)} lines`] : []),
  ];
}

const LAYOUT_FILES: ReadonlySet<string> = new Set([
  "SKILL.md",
  "references/01-composition-and-architecture.md",
  "references/03-components-di-and-lifecycle.md",
  "references/09-persistence-k8s-and-deploy.md",
]);

const skillFiles: readonly string[] = [
  "SKILL.md",
  ...readdirSync(join(SKILLS, "references")).map((name) => `references/${name}`),
];
const textOf = (name: string): string => readFileSync(join(SKILLS, name), "utf8");
const shipped: readonly Snippet[] = skillFiles.flatMap((name) => snippetsOf(name, textOf(name)));
const inLayoutFiles = (snippet: Snippet): boolean =>
  LAYOUT_FILES.has(snippet.where.slice(0, snippet.where.lastIndexOf(":")));

/** One snippet of a made-up file, for the rules' own tests. */
const sample = (lang: string, file: string | undefined, body: string): Snippet => ({
  where: "x.md:1",
  lang,
  file,
  body,
});

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
    "src/a/agents/support.agent.ts",
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
    const files = shipped.flatMap((snippet) => (snippet.file === undefined ? [] : [snippet.file]));

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

  it("AC1: SKILL.md, 01, 03 and 09 show one class per file, each under 200 lines", () => {
    const layout = shipped.filter(inLayoutFiles);

    expect(layout.length).toBeGreaterThan(40);
    expect(layout.flatMap(oneEntityOf)).toEqual([]);
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
