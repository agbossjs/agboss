// The project skills shipped with `agboss` (#305, packages/agboss/skills/agboss/): besides the
// checks of every doc (snippets compile, one call per line, commands exist), check:docs checks
//   1. SKILL.md: its frontmatter first, then the version header — the version of
//      packages/agboss/package.json;
//   2. every `[x.y]` code a skill file mentions exists in the sources; once reference 11 declares
//      its catalog complete (`<!-- agboss-skills-catalog: complete -->`), it lists every `RuleCode`
//      member and every application warning code;
//   3. the matrix coverage (packages/agboss/tests/skills/coverage.ts): each name in its file and
//      exported by a public entry (packages/agboss/api/*.api.md);
//   4. a skill file names project commands only — `npx agboss …` (its options checked like every
//      doc's) and `npm test`, never the repo's `npm run …` or `make …`; `npm test` may be prefixed
//      only by `AGBOSS_VCR_MODE=<mode>`, a value of `VCRMode` (#395 S5:
//      `AGBOSS_VCR_MODE=RECORD_STALE npm test` beside `npx agboss check --cassettes`).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { codeOf } from "./references.mjs";

const SKILLS = `${sep}skills${sep}agboss${sep}`;
const CODE = String.raw`[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+`;
const MENTION = new RegExp(String.raw`\[(${CODE})\](?!\()`, "g");
const LITERAL = new RegExp(String.raw`["'\x60\[](${CODE})["'\x60\]]`, "g");
const CATALOG_COMPLETE = "<!-- agboss-skills-catalog: complete -->";
const HEADER =
  /^<!-- agboss-skills-version: (\S+) — managed by `agboss check`; edits here are replaced -->$/;

/** The path of a skill file inside `skills/agboss/` (`references/02-….md`); undefined for other docs. */
export function skillPathOf(path) {
  const at = path.lastIndexOf(SKILLS);
  return at < 0
    ? undefined
    : path
        .slice(at + SKILLS.length)
        .split(sep)
        .join("/");
}

function* sourceFiles(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true }))
    if (entry.isFile() && entry.name.endsWith(".ts")) yield join(entry.parentPath, entry.name);
}

/** `RuleCode`'s members, from the public API report. */
function ruleCodesOf(repo) {
  const report = readFileSync(join(repo, "packages/agboss/api/agboss.api.md"), "utf8");
  const union = /export type RuleCode = ([^;]+);/.exec(report)?.[1] ?? "";
  return [...union.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/** The application's assembly warnings (`[application.in-memory-cost-ledger]`, …). */
function applicationWarningCodesOf(repo) {
  const log = readFileSync(join(repo, "packages/agboss/src/application/start-log.ts"), "utf8");
  return [...log.matchAll(/code: "([^"]+)"/g)].map((match) => match[1]);
}

/** Every code the packages' sources name: string literals and `[x.y]` in messages. */
function sourceCodesOf(repo) {
  const codes = new Set();
  for (const name of readdirSync(join(repo, "packages")))
    for (const file of sourceFiles(join(repo, "packages", name, "src")))
      for (const [, code] of readFileSync(file, "utf8").matchAll(LITERAL)) codes.add(code);
  return codes;
}

/** Every name a public entry exports, from the API reports (`agboss/internal` is not public). */
function exportedNamesOf(repo) {
  const dir = join(repo, "packages/agboss/api");
  const names = new Set();
  for (const file of readdirSync(dir).filter(
    (f) => f.endsWith(".api.md") && !f.includes("internal"),
  )) {
    const report = readFileSync(join(dir, file), "utf8");
    for (const [, name] of report.matchAll(
      /^export (?:declare )?(?:abstract )?(?:const|let|function|class|interface|type|enum|namespace) (\w+)/gm,
    ))
      names.add(name);
    for (const [, name] of report.matchAll(/^export \{ \w+ as (\w+) \}/gm)) names.add(name);
  }
  return names;
}

function headerProblems(doc, markdown, version) {
  const lines = markdown.split("\n");
  const close = lines.indexOf("---", 1);
  if (lines[0] !== "---" || close < 0)
    return [`${doc}:1: SKILL.md starts with its frontmatter (--- name, description ---)`];
  const header = lines.slice(close + 1).findIndex((line) => line.trim() !== "") + close + 1;
  const found = HEADER.exec(lines[header] ?? "")?.[1];
  if (found === undefined)
    return [`${doc}:${String(header + 1)}: the version header follows the frontmatter`];
  return found === version
    ? []
    : [`${doc}:${String(header + 1)}: skills version ${found}, agboss is ${version}`];
}

/** `VCRMode`'s values, from the source: what `AGBOSS_VCR_MODE` may be set to. */
function vcrModesOf(repo) {
  const source = readFileSync(join(repo, "packages/agboss/src/testing/vcr.ts"), "utf8");
  const body = /export enum VCRMode \{([^}]+)\}/.exec(source)?.[1] ?? "";
  return new Set([...body.matchAll(/^\s*\w+ = "([^"]+)",/gm)].map((match) => match[1]));
}

/** The process variables a skill may set before `npm test`, each with the values it takes. */
const TEST_VARIABLES = (repo) => new Map([["AGBOSS_VCR_MODE", vcrModesOf(repo)]]);

/** `VAR=value … npm test`: each prefix a variable the framework reads, with a value it takes. */
function npmTestProblems(doc, part, variables) {
  const problems = [];
  for (const [, prefix] of part.text.matchAll(/((?:\b[A-Z][A-Z0-9_]*=\S*\s+)+)npm test\b/g))
    for (const [name, value] of prefix
      .trim()
      .split(/\s+/)
      .map((pair) => pair.split("="))) {
      const values = variables.get(name);
      if (values === undefined)
        problems.push(
          `${doc}:${String(part.line)}: npm test takes only ${[...variables.keys()].join(", ")} (${name} is not one)`,
        );
      else if (!values.has(value))
        problems.push(
          `${doc}:${String(part.line)}: ${name}=${value} is not one of ${[...values].join(", ")}`,
        );
    }
  return problems;
}

function mentionProblems(doc, markdown, known, variables) {
  const problems = [];
  markdown.split("\n").forEach((line, index) => {
    for (const [, code] of line.matchAll(MENTION))
      if (!known.has(code)) problems.push(`${doc}:${String(index + 1)}: unknown code [${code}]`);
  });
  for (const part of codeOf(markdown)) {
    if (/\bnpm run \S|(?<![\w-])make [a-z]/.test(part.text))
      problems.push(`${doc}:${String(part.line)}: a skill names only npx agboss … and npm test`);
    problems.push(...npmTestProblems(doc, part, variables));
  }
  return problems;
}

function catalogProblems(doc, markdown, catalog) {
  if (!markdown.includes(CATALOG_COMPLETE)) return [];
  return catalog
    .filter((code) => !markdown.includes(`[${code}]`))
    .map((code) => `${doc}: the error catalog misses [${code}]`);
}

function coverageProblems(doc, markdown, names, exported) {
  return names.flatMap((name) => [
    ...(new RegExp(String.raw`(?<![\w$])${name}(?![\w$])`).test(markdown)
      ? []
      : [`${doc}: does not cover ${name} (packages/agboss/tests/skills/coverage.ts)`]),
    ...(exported.has(name) ? [] : [`${doc}: ${name} is not exported by a public entry`]),
  ]);
}

/** The skill checks for the docs among `docs` that are skill files (`{ doc, path, markdown }`). */
export async function skillsProblems(repo, docs) {
  const skills = docs.filter((entry) => skillPathOf(entry.path) !== undefined);
  if (skills.length === 0) return [];
  const coverageFile = join(repo, "packages/agboss/tests/skills/coverage.ts");
  const { SKILL_COVERAGE } = await import(pathToFileURL(coverageFile).href);
  const version = JSON.parse(
    readFileSync(join(repo, "packages/agboss/package.json"), "utf8"),
  ).version;
  const rules = ruleCodesOf(repo);
  const catalog = [...rules, ...applicationWarningCodesOf(repo)];
  // `[rule.code]` is the notation of any code, as the routing tables write it
  const known = new Set([...catalog, ...sourceCodesOf(repo), "rule.code"]);
  const exported = exportedNamesOf(repo);
  const variables = TEST_VARIABLES(repo);
  return skills.flatMap(({ doc, path, markdown }) => {
    const skill = skillPathOf(path);
    return [
      ...(skill === "SKILL.md" ? headerProblems(doc, markdown, version) : []),
      ...mentionProblems(doc, markdown, known, variables),
      ...(skill.startsWith("references/11-") ? catalogProblems(doc, markdown, catalog) : []),
      ...coverageProblems(doc, markdown, SKILL_COVERAGE[skill] ?? [], exported),
    ];
  });
}
