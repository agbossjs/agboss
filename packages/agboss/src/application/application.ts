import { callerFile } from "../components/call-site.js";
import type { Class, Provider } from "../components/injection.js";
import { ComponentError } from "../components/metadata.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import { NodeKind } from "../flow/ast.js";

/**
 * `@Application` (#261) — the one point of the whole app: what `createApp(App, { env })` and
 * `testWith(App)` take. It lists the top-level workflows, the infrastructure (`providers`: a
 * framework contract's implementation, found by inheritance; none → the built-in in-memory default)
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
   * `BaseCheckpointSaver`), created by the container — never `new`.
   */
  readonly providers?: readonly Provider[];
  /** Every `@Budget` of the application (`config/budget.config.ts`). */
  readonly budgets?: readonly Class[];
}

/** What `@Application` recorded: its options and the file it is declared in. */
export interface ApplicationDeclaration {
  readonly options: ApplicationOptions;
  readonly source?: string;
}

const applications = new WeakMap<Class, ApplicationDeclaration>();

export function Application(options: ApplicationOptions) {
  const source = callerFile();
  return <TClass extends Class>(value: TClass): TClass => {
    applications.set(value, source === undefined ? { options } : { options, source });
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
