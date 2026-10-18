import { type AssembledWorkflow } from "agboss";
import {
  applicationModelUsesOf,
  checkModelUses,
  directoryOf,
  modelSummaryOf,
  problemLine,
  workflowsOfApplication,
  type ModelUse,
  type ProviderFetch,
} from "agboss/internal";
import type { ModelProblem, ModelProviderDirectory } from "agboss/models";

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

/** The model uses of every workflow of the workflow's application, and who serves them (#266). */
async function applicationModelsOf(bundle: AssembledWorkflow): Promise<ApplicationModels> {
  const workflows = await workflowsOfApplication(bundle);
  // one application, one list of model providers: every workflow of it has the same
  return { uses: applicationModelUsesOf(workflows), directory: directoryOf(bundle.modelProviders) };
}

/**
 * Every model setting of the application the workflow is in (every workflow it lists) that does not
 * fit its model, as its resolved provider lists it (no API key).
 */
export async function modelProblemsOf(
  bundle: AssembledWorkflow,
  env: NodeJS.ProcessEnv,
  send?: ProviderFetch,
): Promise<readonly ModelProblem[]> {
  return problemsOf(await applicationModelsOf(bundle), env, send);
}

const problemsOf = (
  { uses, directory }: ApplicationModels,
  env: NodeJS.ProcessEnv,
  send: ProviderFetch | undefined,
): Promise<readonly ModelProblem[]> =>
  checkModelUses(uses, directory, { env, ...(send === undefined ? {} : { send }) });

/**
 * `agboss check --models`: every model setting of the application against what its provider says the
 * model supports — all problems at once, exit code 1 when there is any. Needs no API key.
 */
export async function checkWorkflowModels(
  bundle: AssembledWorkflow,
  env: NodeJS.ProcessEnv,
  send?: ProviderFetch,
): Promise<ModelCheckReport> {
  const models = await applicationModelsOf(bundle);
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
