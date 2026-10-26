// Writes a doc's snippets as a small project and typechecks it against the built `agboss`
// package (#196): the folder links the repo's node_modules, so `agboss`, `@agboss/core/dto`, …
// resolve exactly as in a project that installed it.
import { mkdirSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";
import { sourceOf } from "./snippets.mjs";

/** The folder all docs are written under: `node_modules` linked, ESM, the repo's tsconfig. */
export function prepareRoot(root, repo) {
  mkdirSync(root, { recursive: true });
  const modules = join(root, "node_modules");
  if (!existsSync(modules)) symlinkSync(join(repo, "node_modules"), modules, "dir");
  writeFileSync(join(root, "package.json"), '{ "private": true, "type": "module" }\n');
  const config = {
    extends: join(repo, "tsconfig.base.json"),
    compilerOptions: {
      moduleDetection: "force",
      noEmit: true,
      typeRoots: [join(repo, "node_modules", "@types")],
    },
  };
  writeFileSync(join(root, "tsconfig.json"), `${JSON.stringify(config, null, 2)}\n`);
}

const folderOf = (doc) => doc.replace(/\.md$/i, "").replace(/[^\w-]+/g, "_");

/** Writes every snippet of one doc; returns the compiled files with where they come from. */
export function writeDoc(root, doc, snippets) {
  const folder = join(root, folderOf(doc));
  const files = [];
  for (const snippet of snippets) {
    if (!snippet.compiled && snippet.file === undefined) continue;
    const name = snippet.file ?? `snippet-line-${String(snippet.line)}.ts`;
    const path = join(folder, name);
    const { text, offset } = sourceOf(snippet);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    if (snippet.compiled) files.push({ path, snippet, offset });
  }
  return { folder, files };
}

function optionsOf(root) {
  const read = ts.readConfigFile(join(root, "tsconfig.json"), (path) => ts.sys.readFile(path));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
  // TS18003 "no inputs": the files are passed to the program, not found by the config
  const errors = [read.error, ...parsed.errors].filter((e) => e && e.code !== 18003);
  if (errors.length > 0)
    throw new Error(
      errors.map((e) => ts.flattenDiagnosticMessageText(e.messageText, " ")).join("; "),
    );
  return parsed.options;
}

/** `README.md:12` for a diagnostic, mapped from the written file back to the doc's line. */
function placeOf(diagnostic, byPath) {
  const file = diagnostic.file;
  const written = file ? byPath.get(file.fileName) : undefined;
  if (!file || !written || diagnostic.start === undefined) return file?.fileName ?? "(global)";
  const { line } = file.getLineAndCharacterOfPosition(diagnostic.start);
  const inCode = line - written.offset;
  const { doc, code } = written.snippet;
  if (inCode < 0 || inCode >= code.length)
    return `${doc}:${String(written.snippet.line - 1)} (hidden snippet-context)`;
  return `${doc}:${String(written.snippet.line + inCode)}`;
}

/** Type errors of the written files (with `extra` files compiled alongside), as `doc:line: TSxxxx message`. */
export function typecheck(root, files, extra = []) {
  if (files.length === 0) return [];
  const program = ts.createProgram([...files.map((file) => file.path), ...extra], {
    ...optionsOf(root),
    noEmit: true,
  });
  const byPath = new Map(files.map((file) => [ts.sys.resolvePath(file.path), file]));
  for (const file of files) byPath.set(file.path, file);
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n  ");
    return `${placeOf(diagnostic, byPath)}: TS${String(diagnostic.code)} ${text}`;
  });
}
