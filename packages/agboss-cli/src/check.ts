import { applicationWarningsOf, type AssembledApplication } from "agboss/internal";
import { assembleApplication, loadCliApplication } from "./cli/cli-application.js";
import { flagOption, textOption, type CommandContext, type CommandHandler } from "./cli/context.js";
import { environmentProblems } from "./cli/check-environment.js";
import { evalSuiteProblems, type EvalSuitesCheck } from "./cli/check-eval-suites.js";
import { modelProblemsOf } from "./cli/check-models.js";
import { cassetteProblems } from "./cli/check-cassettes.js";
import { envOption } from "./cli/environment.js";
import { assemble, modelProblem, problemText, type CheckProblem } from "./cli/check-problems.js";
import { checkReportOf, type CheckReport } from "./cli/check-report.js";
import { CliError } from "./cli/errors.js";
import { writeCheckedTypes } from "./cli/flow-types.js";
import { skillsField, syncCommandSkills } from "./cli/skills.js";
import { checkProblemsOf } from "./cli/types-problems.js";

/**
 * The application's assembly warnings (#261): its budgets on an in-memory cost ledger, its pauses
 * in memory — printed, and errors under `--strict`.
 */
function applicationProblems({ context, file, assembled }: CheckTarget): Promise<CheckProblem[]> {
  const found = applicationWarningsOf(assembled).map((warning) => ({ file, ...warning }));
  if (flagOption(context.values, "strict")) return Promise.resolve(found);
  found.forEach((problem) => {
    context.say(`warning: ${problemText(problem)}`);
  });
  return Promise.resolve([]);
}

/** What a check gets: the assembled application and where it came from. */
export interface CheckTarget {
  readonly context: CommandContext;
  /** The application's path as it was set: problems name it. */
  readonly file: string;
  readonly assembled: AssembledApplication;
  readonly env: NodeJS.ProcessEnv;
  /** `--env <name>`; undefined = the default. */
  readonly envName: string | undefined;
  /** `--models`: the checks connect, so the environment's secrets must be set (#266). */
  readonly needsSecrets: boolean;
}

/** A named check of `agboss check`; none needs an API key. */
export interface ApplicationCheck {
  readonly name: string;
  /** Set = runs only with this flag (it needs the network); unset = runs on every `agboss check`. */
  readonly flag?: string;
  readonly run: (target: CheckTarget) => Promise<readonly CheckProblem[]>;
}

/**
 * Every check after assembly (assembly itself — loading, graph rules, DI, config — always runs first).
 * Adding a check is one line here.
 */
export const CHECKS: readonly ApplicationCheck[] = [
  { name: "environment", run: environmentProblems },
  { name: "application", run: applicationProblems },
  {
    // assembly reads and checks every prompt (#199): its problems are reported as prompt.* by
    // assemble(); an application that assembled has none left
    name: "prompts",
    run: () => Promise.resolve([]),
  },
  {
    name: "models",
    flag: "models",
    run: async ({ file, assembled, env }) =>
      (await modelProblemsOf(assembled, env)).map((problem) => modelProblem(file, problem)),
  },
  // the VCR cassettes against the components (#395 PR 4): no test is run, no key needed
  { name: "cassettes", flag: "cassettes", run: cassetteProblems },
];

/** An application whose assembly failed: its suites are not checked. */
const NO_SUITES: EvalSuitesCheck = { suites: 0, problems: [] };

/** The checks after a successful assembly, in order. */
async function problemsAfterAssembly(
  target: CheckTarget,
  selected: readonly ApplicationCheck[],
): Promise<CheckProblem[]> {
  const problems: CheckProblem[] = [];
  for (const check of selected) problems.push(...(await check.run(target)));
  return problems;
}

/** The report as `--json` carries it: everything but the printed lines. */
const reportData = ({ title, starts, environment }: CheckReport): Record<string, unknown> => ({
  title,
  starts,
  ...(environment === undefined ? {} : { environment }),
});

/** What an assembled application gives: its report, then its checks' problems. */
interface CheckedApplication {
  readonly report: CheckReport;
  readonly problems: readonly CheckProblem[];
}

/** The report printed first (#268 AC5), then every selected check run in order. */
async function reportAndCheck(
  target: Pick<CheckTarget, "context" | "file" | "assembled">,
  selected: readonly ApplicationCheck[],
): Promise<CheckedApplication> {
  const { context } = target;
  const envName = envOption(context);
  const report = await checkReportOf(target.assembled, envName);
  [...report.lines, ""].forEach(context.say);
  const problems = await problemsAfterAssembly(
    {
      ...target,
      env: context.io.env,
      envName,
      needsSecrets: flagOption(context.values, "models"),
    },
    selected,
  );
  return { report, problems };
}

/**
 * `agboss check [--models] [--cassettes] [--strict] [--profile <p>] [--env <name>] [--json]` — every workflow of
 * the application; no API key needed. After the assembly it prints the report (#268 AC5): the
 * worst case of one call of each start and, with `--env`, the process variables it needs.
 */
export const handle: CommandHandler = async (context) => {
  // the project skills (#305) first: an application that does not assemble is when they help most
  const skills = syncCommandSkills(context);
  const loaded = await loadCliApplication(context);
  const file = loaded.path.shown;
  // the flow's types (#272): .agboss/types.d.ts written before the checks report; --strict makes
  // the analyser's warnings errors
  const typed = await writeCheckedTypes(context, loaded.path, flagOption(context.values, "strict"));
  const selected = CHECKS.filter(
    (check) => check.flag === undefined || flagOption(context.values, check.flag),
  );
  const profile = textOption(context.values, "profile");
  const assembly = await assemble(file, () => assembleApplication(context, loaded, profile));
  const checked =
    assembly.kind === "failed"
      ? { problems: assembly.problems, report: undefined }
      : await reportAndCheck({ context, file, assembled: assembly.assembled }, selected);
  // Loop 0 of the eval pipeline (#396 S5): the suites assembled on the application that assembled
  const suites =
    assembly.kind === "failed" ? NO_SUITES : await evalSuiteProblems(context, loaded.application);
  // a types file not written is never `ok` (#371, #376): generation's errors the assembly did not
  // report, and the assembly's own named by generation's files where it knew none
  const problems: readonly CheckProblem[] = checkProblemsOf(typed, [
    ...checked.problems,
    ...suites.problems,
  ]);
  const { report } = checked;
  const checks = [
    "assembly",
    ...selected.map((check) => check.name),
    ...(suites.suites === 0 ? [] : ["eval-suites"]),
    ...(typed.types === undefined ? [] : ["types"]),
  ];
  problems.forEach((problem) => {
    context.say(problemText(problem));
  });
  if (problems.length === 0) context.say(`ok: ${file} — ${checks.join(", ")}`);
  const result = {
    application: file,
    checks,
    problems,
    ...(typed.types === undefined ? {} : { types: typed.types }),
    ...(report === undefined ? {} : { report: reportData(report) }),
    ...skillsField(skills),
  };
  const warnings = [...typed.warnings, ...skills.warnings];
  if (problems.length === 0) return { result, warnings };
  const failure = new CliError(
    "project",
    "check.failed",
    `${String(problems.length)} problem(s) in ${file}`,
  );
  return { result, failure, warnings };
};
