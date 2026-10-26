import {
  applicationModelUsesOf,
  checkModelUses,
  directoryOf,
  modelSummaryOf,
  problemLine,
  type AssembledApplication,
  type ModelUse,
  type ProviderFetch,
} from "@agboss/core/internal";
import type { ModelProblem, ModelProviderDirectory } from "@agboss/core/models";

/** What `agboss check --models` prints and the exit code it ends with. */
export interface ModelCheckReport {
  readonly lines: readonly string[];
  readonly exitCode: 0 | 1;
}

/** The model uses of every workflow of an application and the directory of its model providers. */
interface ApplicationModels {
  readonly uses: readonly ModelUse[];
  readonly directory: ModelProviderDirectory;
}

/** The model uses of every workflow of the application, and who serves them (#266). */
function applicationModelsOf({ workflows }: AssembledApplication): ApplicationModels {
  // one application, one list of model providers: every workflow of it has the same
  const [first] = workflows;
  return {
    uses: applicationModelUsesOf(workflows),
    directory: directoryOf(first?.modelProviders ?? []),
  };
}

/**
 * Every model setting of the application (every workflow it runs) that does not fit its model, as its resolved provider lists it (no API key).
 */
export function modelProblemsOf(
  assembled: AssembledApplication,
  env: NodeJS.ProcessEnv,
  send?: ProviderFetch,
): Promise<readonly ModelProblem[]> {
  return problemsOf(applicationModelsOf(assembled), env, send);
}

const problemsOf = (
  { uses, directory }: ApplicationModels,
  env: NodeJS.ProcessEnv,
  send: ProviderFetch | undefined,
): Promise<readonly ModelProblem[]> =>
  // the command asks the providers anyway: their routing against each model's endpoints too (#395)
  checkModelUses(uses, directory, {
    env,
    endpoints: true,
    ...(send === undefined ? {} : { send }),
  });

/**
 * `agboss check --models`: every model setting of the application against what its provider says the
 * model supports — all problems at once, exit code 1 when there is any. Needs no API key.
 */
export async function checkApplicationModels(
  assembled: AssembledApplication,
  env: NodeJS.ProcessEnv,
  send?: ProviderFetch,
): Promise<ModelCheckReport> {
  const models = applicationModelsOf(assembled);
  const { uses, directory } = models;
  const problems = await problemsOf(models, env, send);
  if (problems.length === 0) {
    return {
      lines: [
        ...modelSummaryOf(uses, directory),
        `ok: ${String(uses.length)} model settings fit their models`,
      ],
      exitCode: 0,
    };
  }
  return {
    lines: [
      `ConfigurationError: ${String(problems.length)} model setting(s) do not fit their models`,
      ...problems.map((problem) => `  ${problemLine(problem)}`),
    ],
    exitCode: 1,
  };
}
