import { workflowOf } from "../components/assemble.js";
import type { ProviderModule } from "../components/container/registrations.js";
import type { Class } from "../components/injection.js";
import { moduleOf } from "../components/module.js";
import { NodeKind } from "../flow/ast.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import { GraphRuleError, type RuleViolation } from "../graph/rule-error.js";
import { withProfile } from "../profile-workflow.js";
import { seconds, type Milliseconds } from "../units/index.js";
import type { AssembledWorkflow } from "../workflow.js";
import { requireApplication, type ApplicationOptions } from "./application.js";
import { applicationRuleViolations } from "./application-rules.js";
import { crossWorkflowViolations } from "./workflow-rules.js";

/**
 * The assembly of an `@Application` (#261): its own rules (names, its workflows, budgets, where the
 * infrastructure is listed), every workflow assembled with the application's providers, then the
 * rules across workflows (a start is the door of one workflow, names unique in the application).
 * Every violation at once, before any model call.
 */

/** An assembled application: what `createApp` and `testWith` build an app instance from. */
export interface AssembledApplication {
  readonly application: Class;
  readonly name: string;
  readonly version: string;
  /** The file `@Application` is declared in: its `environments/` folder is next to it. */
  readonly source?: string;
  /** `@Application({ environment })`: the contract its environments are typed by. */
  readonly environment?: Class;
  /** The application's own providers and budgets, then every workflow's providers. */
  readonly modules: readonly ProviderModule[];
  readonly budgets: readonly Class[];
  /** The top-level workflows, in the order listed. */
  readonly workflows: readonly AssembledWorkflow[];
  /** How long a stop waits for the running executions (`@Application({ shutdownTimeout })`). */
  readonly shutdownTimeout: Milliseconds;
}

/** The default shutdown timeout (#265 S51): under the usual 30 s grace period and the 30 s lease. */
const SHUTDOWN_TIMEOUT: Milliseconds = seconds(25);

/** How the workflows are assembled: a profile on top of each (`profiles/<workflow>/<profile>.yaml`). */
export interface ApplicationAssembly {
  readonly profile?: string | undefined;
  readonly profileRoot?: string | undefined;
}

/** The application's own module: its providers and its budgets (the container creates both). */
export const applicationModule = (options: ApplicationOptions): ProviderModule => ({
  owner: options.name,
  declaredIn: "@Application",
  providers: [...(options.providers ?? []), ...(options.budgets ?? [])],
});

/** The modules of every workflow listed (each `@Workflow` class's own providers). */
export const workflowModules = (workflows: readonly Class[]): ProviderModule[] =>
  workflows.flatMap((workflow) => {
    if (declarationOf(workflow)?.kind !== NodeKind.Workflow) return [];
    const module = moduleOf(workflow);
    return [{ owner: module.name, providers: module.providers ?? [] }];
  });

/** Each workflow assembled; the rule violations of all of them collected, other errors rethrown. */
async function assembleWorkflows(
  workflows: readonly Class[],
  modules: readonly ProviderModule[],
  assembly: ApplicationAssembly,
  owner: { readonly name: string; readonly defaults?: ApplicationOptions["defaults"] },
): Promise<{ readonly assembled: AssembledWorkflow[]; readonly errors: GraphRuleError[] }> {
  const assembled: AssembledWorkflow[] = [];
  const errors: GraphRuleError[] = [];
  for (const workflow of workflows) {
    try {
      const bundle = await workflowOf(workflow, modules, owner);
      assembled.push(await withProfile(bundle, assembly.profile, assembly.profileRoot));
    } catch (error) {
      if (!(error instanceof GraphRuleError)) throw error;
      errors.push(error);
    }
  }
  return { assembled, errors };
}

/** The rules an application breaks, its workflows' included: a `GraphRuleError` naming the application. */
class ApplicationRuleError extends GraphRuleError {
  constructor(violations: readonly RuleViolation[]) {
    super(violations);
    const lines = violations.map((item) => `  - [${item.code}] ${item.message}`);
    this.message = `The application breaks ${String(violations.length)} rule(s):\n${lines.join("\n")}`;
  }
}

/** One error for everything found: a single workflow's own error as it is, else all violations. */
function throwIfAny(own: readonly RuleViolation[], errors: readonly GraphRuleError[]): void {
  const [only] = errors;
  if (own.length === 0 && errors.length === 1 && only !== undefined) throw only;
  const all = [...own, ...errors.flatMap((error) => error.violations)];
  if (all.length > 0) throw new ApplicationRuleError(all);
}

export async function applicationOf(
  application: Class,
  assembly: ApplicationAssembly = {},
  where = "createApp",
): Promise<AssembledApplication> {
  const { options, source } = requireApplication(application, where);
  const own = applicationRuleViolations(application, options);
  const modules = [applicationModule(options), ...workflowModules(options.workflows)];
  const workflows = options.workflows.filter(
    (workflow) => declarationOf(workflow)?.kind === NodeKind.Workflow,
  );
  const { assembled, errors } = await assembleWorkflows(workflows, modules, assembly, options);
  throwIfAny([...own, ...crossWorkflowViolations(assembled)], errors);
  return {
    application,
    name: options.name,
    version: options.version,
    ...(source === undefined ? {} : { source }),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    modules,
    budgets: options.budgets ?? [],
    workflows: assembled,
    shutdownTimeout: options.shutdownTimeout ?? SHUTDOWN_TIMEOUT,
  };
}
