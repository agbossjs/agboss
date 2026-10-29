/**
 * The layout rules of #470 and #474, applied to the files the shipped skills' snippets write and to
 * the real files of `examples/flow-patterns` and of `agboss generate` (skills-layout.test.ts).
 *
 * A project's `src/` holds kind folders, optionally under one domain level (`src/[<domain>/]<kind>/…`):
 * a domain is any folder that is not a kind folder and holds only kind folders; the application file
 * and `environments/` stay at the `src/` root. A workflow lives in `workflows/<w>/` with its starts and
 * finishes, a prompt-bearing component in `<kind>/<n>/<n>.<suffix>.ts` with its `<n>.prompt.md`, a DTO
 * in `dto/`. `tests/` mirrors `src/`. Every violation names where it is and the file.
 */

/** A file of a project: where it was found (a skill file and line, or a folder) and its path. */
export interface Placed {
  readonly where: string;
  readonly file: string | undefined;
}

/** A fenced block of a skill file: its language, the file it writes (if any) and its body. */
export interface Snippet extends Placed {
  readonly lang: string;
  readonly body: string;
}

/** The violation a rule found, named by where and the file. */
export type Violation = string;

/** Every path of one project — a skill file's snippets, or a folder's files — for the rules that look around. */
export type ProjectFiles = ReadonlySet<string>;

const FENCE = /^```(\w+)([^\n]*)\n([\s\S]*?)^```/gm;

export function snippetsOf(name: string, markdown: string): Snippet[] {
  return [...markdown.matchAll(FENCE)].map((match) => {
    const [, lang = "", info = "", body = ""] = match;
    const line = markdown.slice(0, match.index).split("\n").length;
    return { where: `${name}:${String(line)}`, lang, file: /file=(\S+)/.exec(info)?.[1], body };
  });
}

/** The kinds of #470 and the one extension each folder holds. */
export const KIND_FOLDERS: Readonly<Record<string, string>> = {
  services: ".service.ts",
  repositories: ".repository.ts",
  errors: ".error.ts",
  schemas: ".schema.ts",
  dto: ".dto.ts",
  sql: ".sql",
};

/** A file in a kind folder has its kind's extension, and a file of a kind is in its folder (#470). */
export function placementOf(placed: Placed): Violation[] {
  if (placed.file === undefined) return [];
  const file = placed.file.replace(/\.test\.ts$/, ".ts"); // a test is of its module's kind
  const folder = file.split("/").at(-2) ?? "";
  const found: Violation[] = [];
  const own = KIND_FOLDERS[folder];
  if (own !== undefined && !file.endsWith(own))
    found.push(`${placed.where} ${placed.file}: ${folder}/ holds only *${own}`);
  for (const [kind, extension] of Object.entries(KIND_FOLDERS))
    if (file.endsWith(extension) && folder !== kind)
      found.push(`${placed.where} ${placed.file}: *${extension} belongs in ${kind}/`);
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

export function forbiddenOf(snippet: Snippet): Violation[] {
  if (snippet.lang !== "ts") return [];
  return FORBIDDEN_IN_TS.filter(([pattern]) => pattern.test(snippet.body)).map(
    ([, why]) => `${snippet.where}: ${why}`,
  );
}

export const MAX_FILE_LINES = 200;

const EXPORTED_CLASS = /^export (?:default )?(?:abstract )?class /gm;
const classesIn = (body: string): number => body.match(EXPORTED_CLASS)?.length ?? 0;

/** One class per file and under 200 lines (#470; every skill file since #474). */
export function oneEntityOf(snippet: Snippet): Violation[] {
  if (snippet.file === undefined || snippet.lang !== "ts") return [];
  const classes = classesIn(snippet.body);
  const lines = snippet.body.split("\n").length;
  return [
    ...(classes > 1 ? [`${snippet.where} ${snippet.file}: ${String(classes)} classes`] : []),
    ...(lines > MAX_FILE_LINES ? [`${snippet.where} ${snippet.file}: ${String(lines)} lines`] : []),
  ];
}

/** #474: a TypeScript block that declares an exported class names the file it is (`file=`). */
export function classWithoutFileOf(snippet: Snippet): Violation[] {
  if (snippet.file !== undefined || snippet.lang !== "ts" || classesIn(snippet.body) === 0)
    return [];
  return [`${snippet.where}: an exported class without file= — name the file it lives in`];
}

/** The part of a path a project's layout governs: its root folder and the segments after it. */
interface ProjectPath {
  readonly root: "src" | "tests";
  readonly project: string;
  readonly segments: readonly string[];
}

/** `[<project>/]src/a/b.ts` → `src`, `[a, b.ts]`; a path outside a project's src/ or tests/ → none. */
function projectPathOf(file: string | undefined): ProjectPath | undefined {
  const parts = file?.split("/") ?? [];
  const at = parts.findIndex((part) => part === "src" || part === "tests");
  const root = parts[at];
  if (root !== "src" && root !== "tests") return undefined;
  return { root, project: parts.slice(0, at).join("/"), segments: parts.slice(at + 1) };
}

const sourceOf = (file: string | undefined): readonly string[] | undefined => {
  const path = projectPathOf(file);
  return path?.root === "src" ? path.segments : undefined;
};

/** The prompt-bearing kinds (#474): each component in `<kind>/<n>/<n><suffix>`, its prompt beside it. */
export const PROMPT_KINDS: Readonly<Record<string, string>> = {
  agents: ".agent.ts",
  routers: ".router.ts",
  judges: ".judge.ts",
  arbiters: ".arbiter.ts",
  compactions: ".compaction.ts",
  guardrails: ".guardrail.ts",
  "reply-interpreters": ".reply-interpreter.ts",
};

const WORKFLOW_FILES: readonly string[] = [
  ".workflow.ts",
  ".workflow-start.ts",
  ".workflow-finish.ts",
];

/** A source file of a project, ready for a rule: how a violation names it, its segments, its name. */
interface SourceFile {
  readonly at: string;
  readonly file: string;
  readonly segments: readonly string[];
  readonly name: string;
}

function sourceFileOf(placed: Placed): SourceFile | undefined {
  const segments = sourceOf(placed.file);
  const file = placed.file ?? "";
  return segments === undefined
    ? undefined
    : { at: `${placed.where} ${file}`, file, segments, name: segments.at(-1) ?? "" };
}

const WORKFLOW_ONLY =
  "workflows/<w>/ holds only its *.workflow.ts, *.workflow-start.ts and *.workflow-finish.ts";

/** #474: a workflow, its starts and finishes in `workflows/<w>/`, the workflow named after its folder. */
export function workflowPlacementOf(placed: Placed): Violation[] {
  const source = sourceFileOf(placed);
  if (source === undefined) return [];
  const { at, segments, name } = source;
  const isInWorkflowFolder = segments.at(-3) === "workflows";
  const suffix = WORKFLOW_FILES.find((one) => name.endsWith(one));
  if (suffix === undefined) return isInWorkflowFolder ? [`${at}: ${WORKFLOW_ONLY}`] : [];
  if (!isInWorkflowFolder) return [`${at}: *${suffix} belongs in workflows/<w>/`];
  const folder = segments.at(-2) ?? "";
  return suffix === ".workflow.ts" && name !== `${folder}${suffix}`
    ? [`${at}: a workflow is named after its folder — workflows/${folder}/${folder}.workflow.ts`]
    : [];
}

/** The prompt-bearing kind a file belongs to by its suffix (`.prompt.md` by its folder). */
function promptKindOf(segments: readonly string[]): string | undefined {
  const name = segments.at(-1) ?? "";
  if (name.endsWith(".prompt.md")) return segments.at(-3);
  return Object.keys(PROMPT_KINDS).find((kind) => name.endsWith(PROMPT_KINDS[kind] ?? ""));
}

/** A `*.prompt.md`: in a component's folder, beside that component. */
function promptFileOf(
  at: string,
  file: string,
  kind: string | undefined,
  project: ProjectFiles,
): Violation[] {
  const suffix = PROMPT_KINDS[kind ?? ""];
  const component = file.replace(/\.prompt\.md$/, suffix ?? ".<kind>.ts");
  return suffix !== undefined && project.has(component)
    ? []
    : [`${at}: a *.prompt.md sits beside its component — no ${component}`];
}

/** A file in a prompt kind's folder that is not its component: never loose, never a stranger. */
function strangerOf(at: string, segments: readonly string[]): Violation[] {
  if (PROMPT_KINDS[segments.at(-2) ?? ""] !== undefined)
    return [`${at}: ${segments.at(-2) ?? ""}/ holds one folder per component`];
  const kind = segments.at(-3) ?? "";
  return PROMPT_KINDS[kind] === undefined
    ? []
    : [`${at}: ${kind}/<n>/ holds only its *${PROMPT_KINDS[kind] ?? ""} and *.prompt.md`];
}

/** #474: a prompt-bearing component in `<kind>/<n>/<n><suffix>`, and a `<n>.prompt.md` beside it. */
export function promptFolderOf(placed: Placed, project: ProjectFiles): Violation[] {
  const source = sourceFileOf(placed);
  if (source === undefined) return [];
  const { at, file, segments, name } = source;
  const kind = promptKindOf(segments);
  if (name.endsWith(".prompt.md")) return promptFileOf(at, file, kind, project);
  const suffix = PROMPT_KINDS[kind ?? ""];
  if (kind === undefined || suffix === undefined) return strangerOf(at, segments);
  const isOwnFolder = segments.at(-3) === kind && name === `${segments.at(-2) ?? ""}${suffix}`;
  return isOwnFolder ? [] : [`${at}: a ${kind} component lives in ${kind}/<n>/<n>${suffix}`];
}

/** Every kind folder a project's `src/` may hold, at its root or under one domain (#474). */
export const KINDS: ReadonlySet<string> = new Set([
  "workflows",
  ...Object.keys(PROMPT_KINDS),
  ...Object.keys(KIND_FOLDERS),
  "tools",
  "actions",
  "observers",
  "budgets",
  "tool-interceptors",
  "channels",
  "pii-policies",
  "rag",
  "retrievers",
  "mcp",
  "a2a",
  "model-providers",
  "health-checks",
  "eval-suites",
  "contexts",
  "http",
  "infrastructure",
  "environments",
  "config",
  "scripts",
]);

/** What stays at the `src/` root: the application file and the environments next to it. */
const ROOT_ONLY: ReadonlySet<string> = new Set(["environments"]);
const isApplication = (name: string): boolean => name.endsWith(".application.ts");

/** A file right under a domain (`src/<domain>/x.ts`): never, an application least of all. */
const looseInDomainOf = (at: string, domain: string, name: string): Violation[] =>
  isApplication(name)
    ? [`${at}: *.application.ts stays at the src/ root`]
    : [`${at}: src/${domain}/ is a domain — it holds only kind folders`];

/** #474: `src/[<domain>/]<kind>/…` — one domain level, a domain holds only kind folders. */
export function domainOf(placed: Placed): Violation[] {
  const source = sourceFileOf(placed);
  if (source === undefined) return [];
  const { at, segments } = source;
  const [first = "", second = ""] = segments;
  if (segments.length === 1)
    return isApplication(first) ? [] : [`${at}: src/ holds kind folders and *.application.ts only`];
  if (KINDS.has(first)) return [];
  if (segments.length === 2) return looseInDomainOf(at, first, second);
  if (ROOT_ONLY.has(second)) return [`${at}: ${second}/ stays at the src/ root`];
  return KINDS.has(second)
    ? []
    : [`${at}: src/${first}/${second}/ is not a kind folder — one domain level holds kind folders`];
}

/** The folders of a set of paths (`src/a/b.ts` → `src/a`, `src`). */
function foldersOf(project: ProjectFiles): ReadonlySet<string> {
  const folders = new Set<string>();
  for (const file of project)
    for (let end = file.lastIndexOf("/"); end > 0; end = file.lastIndexOf("/", end - 1))
      folders.add(file.slice(0, end));
  return folders;
}

const join = (...parts: readonly string[]): string => parts.filter((part) => part !== "").join("/");
const HELPER_FOLDERS: ReadonlySet<string> = new Set(["support", "__snapshots__"]);

/** The `src/` path a test mirrors: the module it tests, or the workflow folder it lives in. */
function mirroredOf(
  path: ProjectPath,
  folders: ReadonlySet<string>,
  project: ProjectFiles,
): boolean {
  const { segments } = path;
  const name = segments.at(-1) ?? "";
  const module = join(
    path.project,
    "src",
    ...segments.slice(0, -1),
    name.replace(/\.test\.ts$/, ".ts"),
  );
  if (project.has(module)) return true;
  const workflows = segments.lastIndexOf("workflows");
  return (
    workflows >= 0 &&
    workflows === segments.length - 3 &&
    folders.has(join(path.project, "src", ...segments.slice(0, workflows + 2)))
  );
}

/** #474: `tests/` mirrors `src/` — a test beside the mirror of what it tests, helpers in `support/`. */
export function testMirrorOf(placed: Placed, project: ProjectFiles): Violation[] {
  const path = projectPathOf(placed.file);
  if (path?.root !== "tests") return [];
  const at = `${placed.where} ${placed.file ?? ""}`;
  const folders = foldersOf(project);
  const name = path.segments.at(-1) ?? "";
  if (name.endsWith(".test.ts"))
    return mirroredOf(path, folders, project)
      ? []
      : [
          `${at}: a test mirrors src/ — tests/x/y.test.ts tests src/x/y.ts, or sits in tests/…/workflows/<w>/`,
        ];
  const helper = path.segments.findIndex((segment) => HELPER_FOLDERS.has(segment));
  const parent = join(path.project, "src", ...path.segments.slice(0, helper));
  return helper > 0 && folders.has(parent)
    ? []
    : [`${at}: a test helper sits in support/ or __snapshots__/ of a folder that mirrors src/`];
}

/** Every per-file rule of #470 and #474 that a file's path must pass, in its project. */
export function layoutOf(placed: Placed, project: ProjectFiles): Violation[] {
  return [
    ...placementOf(placed),
    ...workflowPlacementOf(placed),
    ...promptFolderOf(placed, project),
    ...domainOf(placed),
    ...testMirrorOf(placed, project),
  ];
}

const fileShapeOf = (name: string): string => {
  const dot = name.indexOf(".");
  return dot < 0 ? "<n>" : `<n>${name.slice(dot)}`;
};

/**
 * #474 AC2: a path's shape, to compare the generator's files with the snippets' — every name is
 * `<n>`, the project folder and the domain level dropped (`src/billing/agents/refund/refund.agent.ts`
 * → `src/agents/<n>/<n>.agent.ts`); a path outside a project's src/ or tests/ has none.
 */
export function shapeOf(file: string | undefined): string | undefined {
  const path = projectPathOf(file);
  if (path === undefined) return undefined;
  const [first = "", ...rest] = path.segments;
  const segments = rest.length > 0 && !KINDS.has(first) ? rest : path.segments;
  const folders = segments.slice(0, -1).map((segment) => (KINDS.has(segment) ? segment : "<n>"));
  return [path.root, ...folders, fileShapeOf(segments.at(-1) ?? "")].join("/");
}
