import type { AppOptions } from "../app/create-app.js";
import { startComponents, stopComponents } from "../components/container/lifecycle.js";
import type { Class } from "../components/injection.js";
import { namedEnvironmentFor } from "../environments/load.js";
import type { ExecutionHistoryRepository } from "../infrastructure/execution-history.repository.js";
import { applicationContainerOf, clockOf, resolveInfrastructure } from "./application-container.js";
import { applicationOf } from "./assemble.js";
import { contextsOf, environmentOwnerOf } from "./create-app.js";

/**
 * An application's execution history opened for reading (#401 PR 1, `agboss records export`):
 * the application assembled, its environment read, its stores created as an instance creates them
 * — and nothing else: no workflow built, no recovery sweep, no execution moved.
 */
export interface OpenedExecutionHistory {
  /** The application's name (`@Application({ name })`). */
  readonly application: string;
  /** Whether it keeps its history (`@Application({ executionRecordRetention })`). */
  readonly isKept: boolean;
  readonly history: ExecutionHistoryRepository;
  /** Stops and destroys what was created (the SQLite connection). */
  readonly close: () => Promise<void>;
}

/** Opens the execution history of `application` in its `env` environment. */
export async function openExecutionHistory(
  application: Class,
  options: Pick<AppOptions, "env" | "processEnv"> = {},
): Promise<OpenedExecutionHistory> {
  const assembled = await applicationOf(application, {}, "agboss records export");
  const processEnv = options.processEnv ?? process.env;
  const owner = environmentOwnerOf(assembled);
  const environment = await namedEnvironmentFor(owner, options, processEnv);
  const created: unknown[] = [];
  const onCreate = (instance: unknown): void => {
    created.push(instance);
  };
  const clock = clockOf(assembled.modules, { onCreate });
  const contexts = contextsOf(assembled, { ...options, ...environment }, {}, clock);
  const sources = { modules: assembled.modules, clock, contexts };
  const shared = applicationContainerOf(sources, { onCreate });
  const { executionHistory } = resolveInfrastructure(shared, { application: shared, onCreate });
  await startComponents(created);
  return {
    application: assembled.name,
    isKept: assembled.executionRecordRetention !== undefined,
    history: executionHistory,
    close: () => stopComponents(created),
  };
}
