import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  checkFederation,
  contractsOf,
  federationMemberOf,
  FederationProblemCode,
  type FederationMember,
  type FederationProblem,
} from "agboss/internal";
import type { CheckTarget } from "../check.js";
import { flagOption, type CommandContext } from "./context.js";
import { problemText, type CheckProblem } from "./check-problems.js";
import { CliError } from "./errors.js";

/**
 * `agboss check --federation <snapshot…>` (#398 PR 4): the application's declared contracts against
 * its neighbours' `agboss describe --json` snapshots — files, or folders of `*.json` — read from
 * disk only (Q7: no network). `[federation.incompatible-schema]` and `[federation.missing-target]`
 * name their blast radius, the workflows of the consumer that use the contract; an earlier snapshot
 * of the project itself checks that a changed export has a new version
 * (`[federation.version-not-bumped]`, a warning, an error under `--strict`).
 */

/** The snapshot files a path names: itself, or every `*.json` under a folder, in name order. */
function filesOf(given: string): readonly string[] {
  if (!statSync(given).isDirectory()) return [given];
  return readdirSync(given, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => path.join(given, name));
}

/** A snapshot that cannot be read, as a problem of its file. */
const unreadable = (file: string, reason: string): CheckProblem => ({
  file,
  code: FederationProblemCode.SnapshotSchema,
  message: reason,
});

/** Every member the paths name, and the problems of those that are not snapshots. */
function membersOf(
  cwd: string,
  given: readonly string[],
): { readonly members: FederationMember[]; readonly problems: CheckProblem[] } {
  const members: FederationMember[] = [];
  const problems: CheckProblem[] = [];
  for (const entry of given) {
    const absolute = path.resolve(cwd, entry);
    let files: readonly string[];
    try {
      files = filesOf(absolute);
    } catch {
      problems.push(unreadable(entry, "no such file or folder"));
      continue;
    }
    for (const file of files) {
      const shown = path.relative(cwd, file) || file;
      const reading = federationMemberOf(readFileSync(file, "utf8"), shown);
      if (reading.kind === "member") members.push(reading.member);
      else problems.push(unreadable(shown, reading.reason));
    }
  }
  return { members, problems };
}

/** `shop-application › quote-workflow (ask-billing-tool)`, one per use. */
const radiusText = ({ blastRadius }: FederationProblem): string =>
  blastRadius.length === 0
    ? ""
    : ` — affects ${blastRadius
        .map((use) => `${use.application} › ${use.workflow} (${use.tool})`)
        .join(", ")}`;

const problemOf = (problem: FederationProblem): CheckProblem => ({
  file: problem.file,
  code: problem.code,
  message: `${problem.consumer === "" ? problem.producer : `${problem.consumer} → ${problem.producer}`}: ${problem.message}${radiusText(problem)}`,
  blastRadius: problem.blastRadius,
});

const counted = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? "" : "s"}`;

/** The check `CHECKS` runs with `--federation`. */
export function federationProblems({
  context,
  file,
  assembled,
}: CheckTarget): Promise<CheckProblem[]> {
  const given = context.positionals;
  if (given.length === 0)
    throw new CliError(
      "usage",
      "federation.no-snapshots",
      "agboss check --federation needs the neighbours' snapshots: files or folders of agboss describe --json output",
    );
  const { members, problems } = membersOf(context.io.cwd, given);
  const current = {
    name: assembled.name,
    version: assembled.version,
    file,
    contracts: contractsOf(assembled),
  };
  const report = checkFederation(current, members);
  context.say(
    `federation: ${counted(report.applications.length, "application")}, ${counted(report.contracts, "consumed contract")} compared`,
  );
  const isStrict = flagOption(context.values, "strict");
  for (const problem of report.problems) {
    const found = problemOf(problem);
    if (problem.isWarning && !isStrict) context.say(`warning: ${problemText(found)}`);
    else problems.push(found);
  }
  return Promise.resolve(problems);
}

/** Snapshots given without `--federation`: a usage error, never silently ignored. */
export function requireFederationFlag(context: CommandContext): void {
  if (context.positionals.length === 0 || flagOption(context.values, "federation")) return;
  throw new CliError(
    "usage",
    "check.unexpected-argument",
    `agboss check takes no ${context.positionals.join(" ")} — snapshots go with --federation`,
  );
}
