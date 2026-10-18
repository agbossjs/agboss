import { callerFile } from "../components/call-site.js";
import type { Class, Provider } from "../components/injection.js";
import { ComponentError } from "../components/metadata.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import { NodeKind } from "../flow/ast.js";
import type { Milliseconds } from "../units/index.js";
import type { WorkflowDefaults } from "../flow/decorators/workflow.js";

/**
 * `@Application` (#261) — the one point of the whole app: what `createApp(App, { env })` and
 * `testWith(App)` take. It lists the top-level workflows, the infrastructure (`providers`: a
 * framework contract's implementation, found by inheritance; none → the built-in in-memory default;
 * its model providers, #266)
 * and every budget of the application. Its `environments/` folder is next to its file.
 */
export interface ApplicationOptions {
  /** Ends with `-application` (`job-scout-application`). */
  readonly name: string;
  /** The release version (each workflow's own `version` is its behaviour version). */
  readonly version: string;
  /** The top-level workflows; `app.execute(Start, …)` runs any of them by its start. */
  readonly workflows: readonly Class[];
  /**
   * Infrastructure, the only place it is registered: classes that `extends` a framework contract
   * (`CostLedgerRepository`, `ExecutionRecordRepository`, `PausedExecutionRepository`,
   * `BaseCheckpointSaver`), created by the container — never `new`; and the `@ModelProvider`
   * classes (#266) every model of the application resolves to by `serves` — none listed → the
   * built-in `OpenRouterModelProvider` + `DecisionsModelProvider`, one listed → the list is complete.
   */
  readonly providers?: readonly Provider[];
  /** Every `@Budget` of the application (`config/budget.config.ts`). */
  readonly budgets?: readonly Class[];
  /**
   * How long `app.close()` (and SIGTERM / SIGINT) waits for the running executions before it
   * interrupts them (#265 S51): each releases its lease at once and stays `running`, so another
   * instance continues it. Default `seconds(25)` — under the usual 30 s grace period and the lease.
   */
  readonly shutdownTimeout?: Milliseconds;
  /**
   * The environment contract, required — a class with declared fields only
   * (`environments/app.environment.ts`); each `environments/<name>.environment.ts` next to the
   * application file exports `const environment: AppEnvironment = { … }`. An application with no
   * settings declares `EmptyEnvironment` (a contract without fields) and needs no environment file.
   */
  readonly environment: Class;
  /**
   * Defaults of every workflow (#261): merged field by field under each workflow's own `defaults`
   * — the most specific level that sets a field wins (component over workflow over application).
   */
  readonly defaults?: WorkflowDefaults;
}

/** What `@Application` recorded: its options and the file it is declared in. */
export interface ApplicationDeclaration {
  readonly options: ApplicationOptions;
  readonly source?: string;
}

const applications = new WeakMap<Class, ApplicationDeclaration>();

/** The applications that list each workflow, as they are declared (loaded modules only). */
const listedIn = new WeakMap<Class, Class[]>();

export function Application(options: ApplicationOptions) {
  const source = callerFile();
  return <TClass extends Class>(value: TClass): TClass => {
    applications.set(value, source === undefined ? { options } : { options, source });
    for (const workflow of options.workflows)
      listedIn.set(workflow, [...(listedIn.get(workflow) ?? []), value]);
    return value;
  };
}

/** What `@Application` recorded on a class; `undefined` for any other class. */
export const applicationDeclarationOf = (cls: Class): ApplicationDeclaration | undefined =>
  applications.get(cls);

/** The `@Application` declaration of a class; anything else fails, naming the fix. */
export function requireApplication(cls: Class, where: string): ApplicationDeclaration {
  const declaration = applications.get(cls);
  if (declaration !== undefined) return declaration;
  const name = cls.name || "(anonymous class)";
  const fix =
    declarationOf(cls)?.kind === NodeKind.Workflow
      ? `${name} is a @Workflow — list it in an @Application({ name, version, workflows: [${name}] }) and pass the application`
      : `decorate ${name} with @Application({ name, version, workflows })`;
  throw new ComponentError(`${where} takes an @Application class: ${fix}`);
}

/** The applications loaded so far that list `workflow` (the CLI's commands on one workflow, eval). */
export const applicationsListing = (workflow: Class): readonly Class[] =>
  listedIn.get(workflow) ?? [];
