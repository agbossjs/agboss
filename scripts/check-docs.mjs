#!/usr/bin/env node
// Docs that compile (#196), run by `npm run check` after the build:
//   1. every ```ts block of the docs typechecks against the built `agboss` package, with the
//      generated `.agboss/types.d.ts` of the doc's workflows (#272, docs/flow-types.mjs) (conventions — file=, no-check: <reason>, <!-- snippet-context --> — in scripts/docs/snippets.mjs);
//   2. every `scripts/…`, `npm run …`, `make …` and `agboss …` they mention exists, and so does every
//      `agboss …` the CLI's own sources print;
//   3. the ts blocks that build paths have one call per line in their chains (#289, docs/flow-lint.mjs);
//   4. the project skills (packages/agboss/skills/**, #305): their header, codes and matrix coverage
//      (docs/skills.mjs);
//   5. no doc but an ADR or the Changelog points at a folder that left the repository —
//      `examples/job-scout`, now agbossjs/agboss-examples' 08-job-scout (#489, docs/removed-paths.mjs).
// Options: --docs a.md,b.md (default: the root docs and docs/**), --wiki <dir> (instead: every page
// of a GitHub Wiki checkout, whose links to other pages must name existing pages; CI clones the
// wiki and runs this — #240), --out <dir> (keep the written snippets there; default a temporary
// folder), --no-cli-sources (skip step 2 for the CLI's sources; implied by --wiki).
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { conventionProblems, snippetsOf } from "./docs/snippets.mjs";
import { prepareRoot, typecheck, writeDoc } from "./docs/typecheck.mjs";
import { cliCommands, sourceLines } from "./docs/cli-commands.mjs";
import { commandProblems, knownOf, referenceProblems } from "./docs/references.mjs";
import { wikiLinkProblems, wikiPages } from "./docs/wiki.mjs";
import { writeDocTypes } from "./docs/flow-types.mjs";
import { flowLintProblems } from "./docs/flow-lint.mjs";
import { skillsProblems } from "./docs/skills.mjs";
import { removedPathProblems } from "./docs/removed-paths.mjs";

const REPO = realpathSync(new URL("..", import.meta.url).pathname);
const ROOT_DOCS = [
  "README.md",
  "CLAUDE.md",
  "QUALITY.md",
  "WORKFLOW.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
  "SECURITY.md",
];
// the project skills shipped with agboss (#305): checked like every doc, plus docs/skills.mjs
const SKILLS_FOLDER = "packages/agboss/skills";

const { values } = parseArgs({
  options: {
    docs: { type: "string" },
    wiki: { type: "string" },
    out: { type: "string" },
    "no-cli-sources": { type: "boolean", default: false },
  },
});

function docsFolder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(entry.parentPath, entry.name));
}

function docsToCheck() {
  if (values.wiki !== undefined) return wikiPages(resolve(values.wiki));
  if (values.docs !== undefined) return values.docs.split(",").map((doc) => resolve(doc));
  return [
    ...ROOT_DOCS.map((doc) => join(REPO, doc)),
    ...docsFolder(join(REPO, "docs")),
    ...docsFolder(join(REPO, SKILLS_FOLDER)),
  ];
}

const docs = docsToCheck();
const out = values.out ? resolve(values.out) : mkdtempSync(join(tmpdir(), "agboss-docs-"));
mkdirSync(out, { recursive: true });
const root = realpathSync(out);
prepareRoot(root, REPO);
const known = knownOf(REPO, cliCommands(REPO));

const problems = [];
const read = [];
let compiled = 0;
for (const path of docs) {
  const doc = relative(process.cwd(), path) || path;
  const markdown = readFileSync(path, "utf8");
  read.push({ doc, path, markdown });
  const snippets = snippetsOf(markdown, doc);
  problems.push(...conventionProblems(snippets), ...referenceProblems(doc, markdown, known));
  problems.push(...flowLintProblems(snippets), ...removedPathProblems(doc, markdown));
  if (values.wiki !== undefined) problems.push(...wikiLinkProblems(doc, markdown, docs));
  const { folder, files } = writeDoc(root, doc, snippets);
  compiled += files.length;
  const typed = await writeDocTypes(folder, doc, files);
  problems.push(...typed.problems, ...typecheck(root, files, typed.types));
}
if (values.wiki === undefined) problems.push(...(await skillsProblems(REPO, read)));
if (!values["no-cli-sources"] && values.wiki === undefined)
  for (const { place, text } of sourceLines(REPO))
    for (const problem of commandProblems(text, known).filter((line) => line.includes("agboss ")))
      problems.push(`${place}: ${problem}`);

if (!values.out) rmSync(out, { recursive: true, force: true });
if (problems.length > 0) {
  console.error(
    `Docs out of date with the code (${String(problems.length)}):\n  ${problems.join("\n  ")}`,
  );
  process.exit(1);
}
const checked = values.wiki === undefined ? "references exist" : "references and links exist";
console.log(
  `docs ok: ${String(compiled)} snippets compiled in ${String(docs.length)} docs, ${checked}`,
);
