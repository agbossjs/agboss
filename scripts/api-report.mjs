#!/usr/bin/env node
// The public API reports (#195): one `api-extractor` report per entry of the `agboss` package
// (package.json#exports), committed in packages/agboss/api/. A change of the public surface
// shows up as a diff of these files in review.
//   node scripts/api-report.mjs          → check (CI, `npm run check`): fails when a report is stale
//   node scripts/api-report.mjs --write  → rewrite the reports after an intended API change
// Runs on the built declarations: `npm run build` first.
import { Extractor, ExtractorConfig } from "@microsoft/api-extractor";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const PKG = new URL("../packages/agboss/", import.meta.url).pathname;
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

function report(subpath, types) {
  const entry = join(PKG, types);
  if (!existsSync(entry)) throw new Error(`${entry} is missing — run npm run build first`);
  const config = ExtractorConfig.prepare({
    configObject: {
      projectFolder: PKG,
      mainEntryPointFilePath: entry,
      compiler: { tsconfigFilePath: join(PKG, "tsconfig.build.json") },
      apiReport: {
        enabled: true,
        reportFileName: reportName(subpath),
        reportFolder: REPORTS,
        reportTempFolder: temp,
      },
      docModel: { enabled: false },
      dtsRollup: { enabled: false },
      tsdocMetadata: { enabled: false },
      newlineKind: "lf",
      messages: {
        // findings (e.g. a public type using an unexported one) are notes in the report, not errors
        extractorMessageReporting: {
          default: { logLevel: "none", addToApiReportFile: true },
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
  const result = Extractor.invoke(config, { localBuild: write, showVerboseMessages: false });
  if (!write && result.apiReportChanged) {
    // show what differs, so a CI failure is readable without the temp file
    const name = `${reportName(subpath)}.api.md`;
    const diff = spawnSync("diff", ["-u", join(REPORTS, name), join(temp, name)], {
      encoding: "utf8",
    });
    console.error(diff.stdout.split("\n").slice(0, 60).join("\n"));
  }
  return { subpath, ok: result.succeeded, changed: result.apiReportChanged };
}

const expected = new Set(Object.keys(pkg.exports).map((s) => `${reportName(s)}.api.md`));
const stray = existsSync(REPORTS)
  ? readdirSync(REPORTS).filter((name) => name.endsWith(".api.md") && !expected.has(name))
  : [];
let results;
try {
  results = Object.entries(pkg.exports).map(([subpath, { types }]) => report(subpath, types));
} finally {
  rmSync(temp, { recursive: true, force: true });
}
if (write) stray.forEach((name) => rmSync(join(REPORTS, name)));

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
