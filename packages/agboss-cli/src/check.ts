import { applicationWarningsOf, type AssembledApplication } from "agboss/internal";
import { assembleApplication, loadCliApplication } from "./cli/cli-application.js";
import { flagOption, textOption, type CommandContext, type CommandHandler } from "./cli/context.js";
import { environmentProblems } from "./cli/check-environment.js";
import { modelProblemsOf } from "./cli/check-models.js";
import { envOption } from "./cli/environment.js";
import { assemble, modelProblem, problemText, type CheckProblem } from "./cli/check-problems.js";
import { CliError } from "./cli/errors.js";
import { writeCheckedTypes } from "./cli/flow-types.js";

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
];

/** The checks after a successful assembly, in order. */
async function problemsAfterAssembly(
  target: CheckTarget,
  selected: readonly ApplicationCheck[],
): Promise<CheckProblem[]> {
  const problems: CheckProblem[] = [];
  for (const check of selected) problems.push(...(await check.run(target)));
  return problems;
}

/**
 * `agboss check [--models] [--strict] [--profile <p>] [--env <name>] [--json]` — every workflow of
 * the application; no API key needed.
 */
export const handle: CommandHandler = async (context) => {
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
  const problems: CheckProblem[] = [...typed.problems];
  if (assembly.kind === "failed") problems.push(...assembly.problems);
  else
    problems.push(
      ...(await problemsAfterAssembly(
        {
          context,
          file,
          assembled: assembly.assembled,
          env: context.io.env,
          envName: envOption(context),
          needsSecrets: flagOption(context.values, "models"),
        },
        selected,
      )),
    );
  const checks = [
    "assembly",
    ...selected.map((check) => check.name),
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
  };
  if (problems.length === 0) return { result, warnings: typed.warnings };
  const failure = new CliError(
    "project",
    "check.failed",
    `${String(problems.length)} problem(s) in ${file}`,
  );
  return { result, failure, warnings: typed.warnings };
};
