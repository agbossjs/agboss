#!/usr/bin/env node
// The public API reports (#195): one `api-extractor` report per entry of the `@agboss/core` package
// (package.json#exports), committed in packages/agboss/api/. A change of the public surface
// shows up as a diff of these files in review.
//   node scripts/api-report.mjs          → check (CI, `npm run check`): fails when a report is stale
//   node scripts/api-report.mjs --write  → rewrite the reports after an intended API change
// Runs on the built declarations: `npm run build` first.
import { CompilerState, Extractor, ExtractorConfig } from "@microsoft/api-extractor";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { normalizePositions } from "./api-positions.mjs";
import { recordForgotten, strippedNames, unexportedByAnyEntry } from "./api-forgotten.mjs";

// `--package <dir>`: another package folder (the tests plant a hole in a small one)
const pkgAt = process.argv.indexOf("--package");
const PKG =
  pkgAt === -1
    ? new URL("../packages/agboss/", import.meta.url).pathname
    : resolve(process.argv[pkgAt + 1] ?? "") + "/";
const write = process.argv.includes("--write");
// `--reports <dir>`: compare with the reports in another folder (the tests check a changed copy)
const at = process.argv.indexOf("--reports");
const REPORTS = at === -1 ? join(PKG, "api") : resolve(process.argv[at + 1] ?? "");
const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));

const baseName = pkg.name.startsWith("@") ? pkg.name.split("/")[0].slice(1) : pkg.name;

/** `"."` → `agboss`, `"./testing/setup"` → `agboss-testing-setup`. */
const reportName = (subpath) =>
  subpath === "." ? baseName : `${baseName}-${subpath.slice(2).replaceAll("/", "-")}`;

const temp = mkdtempSync(join(tmpdir(), "agboss-api-"));
if (write) mkdirSync(REPORTS, { recursive: true });

function prepare(subpath, types) {
  const entry = join(PKG, types);
  if (!existsSync(entry)) throw new Error(`${entry} is missing — run npm run build first`);
  return ExtractorConfig.prepare({
    configObject: {
      projectFolder: PKG,
      mainEntryPointFilePath: entry,
      compiler: { tsconfigFilePath: join(PKG, "tsconfig.build.json") },
      apiReport: {
        enabled: true,
        reportFileName: reportName(subpath),
        // api-extractor leaves its raw report in `temp` (same folder: nothing for it to compare or
        // copy); the committed report is that text without source positions (#1040), compared and
        // written below
        reportFolder: temp,
        reportTempFolder: temp,
      },
      docModel: { enabled: false },
      dtsRollup: { enabled: false },
      tsdocMetadata: { enabled: false },
      newlineKind: "lf",
      messages: {
        // findings are notes in the report, not errors; a type another public entry exports is no
        // finding, one no public entry exports fails the check below (#895)
        extractorMessageReporting: {
          default: { logLevel: "none", addToApiReportFile: true },
          "ae-forgotten-export": { logLevel: "none", addToApiReportFile: false },
          "ae-missing-release-tag": { logLevel: "none", addToApiReportFile: false },
          // about a dependency's own sources, with a machine-specific absolute path: not our API
          "ae-wrong-input-file-type": { logLevel: "none", addToApiReportFile: false },
        },
        tsdocMessageReporting: { default: { logLevel: "none" } },
        compilerMessageReporting: { default: { logLevel: "warning" } },
      },
    },
    configObjectFullPath: undefined,
    packageJsonFullPath: join(PKG, "package.json"),
  });
}

function report({ subpath, config }, compilerState, found) {
  const result = Extractor.invoke(config, {
    localBuild: true, // never fails on a changed report itself: the comparison is ours, below
    showVerboseMessages: false,
    compilerState,
    messageCallback: recordForgotten(found, subpath),
  });
  const name = `${reportName(subpath)}.api.md`;
  const text = normalizePositions(readFileSync(join(temp, name), "utf8"));
  const committed = join(REPORTS, name);
  const changed = !existsSync(committed) || readFileSync(committed, "utf8") !== text;
  if (write && changed) writeFileSync(committed, text);
  if (!write && changed) {
    // show what differs, so a CI failure is readable without the temp file
    const fresh = join(temp, `normalized-${name}`);
    writeFileSync(fresh, text);
    const diff = spawnSync("diff", ["-u", committed, fresh], { encoding: "utf8" });
    console.error(diff.stdout.split("\n").slice(0, 60).join("\n"));
  }
  return { subpath, ok: result.succeeded, changed };
}

const expected = new Set(Object.keys(pkg.exports).map((s) => `${reportName(s)}.api.md`));
const stray = existsSync(REPORTS)
  ? readdirSync(REPORTS).filter((name) => name.endsWith(".api.md") && !expected.has(name))
  : [];
const internal = pkg.internalExports ?? [];
const publicSubpaths = Object.keys(pkg.exports).filter((s) => !internal.includes(s));
const found = [];
let results = [];
let holes = [];
let stripped = [];
try {
  const entries = Object.entries(pkg.exports).map(([subpath, { types }]) => ({
    subpath,
    config: prepare(subpath, types),
  }));
  // one program for every entry: faster, and the symbols of one entry are those of the others
  const compilerState = CompilerState.create(entries[0].config, {
    additionalEntryPoints: entries.slice(1).map((e) => e.config.mainEntryPointFilePath),
  });
  stripped = strippedNames({ program: compilerState.program, root: PKG });
  // api-extractor cannot follow a name nothing declares: it would stop with an InternalError
  if (stripped.length === 0) results = entries.map((entry) => report(entry, compilerState, found));
  holes = unexportedByAnyEntry({
    program: compilerState.program,
    root: PKG,
    entries: entries.map((e) => ({ subpath: e.subpath, file: e.config.mainEntryPointFilePath })),
    publicSubpaths,
    found,
  });
} finally {
  rmSync(temp, { recursive: true, force: true });
}
if (write) stray.forEach((name) => rmSync(join(REPORTS, name)));

if (stripped.length > 0) {
  const lines = [...new Set(stripped.map((s) => `  ${s.name} — ${s.file}`))];
  console.error(
    `Types of the public API that no declaration holds (#895):\n${lines.join("\n")}\n` +
      "A signature names an `@internal` type, which `stripInternal` removes from the declarations. " +
      "Narrow the signature so it is not named, or export the type from a public entry.",
  );
  process.exit(1);
}
if (holes.length > 0) {
  const byName = Map.groupBy(holes, (hole) => hole.name);
  const lines = [...byName].map(
    ([name, each]) =>
      `  ${name} — ${[...new Set(each.flatMap((h) => h.files))].join(", ")} — used by ${each.map((h) => h.subpath).join(", ")}`,
  );
  console.error(
    `Types of the public API that no public entry exports (#895):\n${lines.join("\n")}\n` +
      "Export each from the entry users import it from, or narrow the signature so it is not named.",
  );
  process.exit(1);
}
const failed = results.filter((r) => !r.ok).map((r) => r.subpath);
const stale = results.filter((r) => !r.ok || r.changed).map((r) => r.subpath);
if (write && failed.length > 0) {
  console.error(`API reports failed: ${failed.join(", ")}`);
  process.exit(1);
} else if (write) {
  console.log(`API reports written: ${results.length} entries (${stale.length} changed)`);
} else if (stale.length > 0 || stray.length > 0) {
  console.error(
    `The public API changed without its report (#195): ${[...stale, ...stray].join(", ")}.\n` +
      "If the change is intended, run `npm run api:update` and commit packages/agboss/api/.",
  );
  process.exit(1);
} else {
  console.log(`API reports up to date: ${results.length} entries`);
}
