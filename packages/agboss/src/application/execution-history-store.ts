import { startComponents, stopComponents } from "../components/container/lifecycle.js";
import type { Class } from "../components/injection.js";
import type { ExecutionHistoryRepository } from "../infrastructure/execution-history.repository.js";
import { resolvedStorageOf } from "../storage/storage-assembly.js";
import { applicationContainerOf, clockOf, resolveInfrastructure } from "./application-container.js";
import { applicationOf } from "./assemble.js";
import type { BuildApplicationOptions } from "./create-app.js";
import { contextsOf } from "./instance-contexts.js";

/**
 * An application's execution history opened for reading (#401 PR 1, `agboss executions export`):
 * the application assembled, its stores created as an instance creates them
 * — and nothing else: no workflow built, no recovery sweep, no execution moved.
 */
export interface OpenedExecutionHistory {
  /** The application's name (`@Application({ name })`). */
  readonly application: string;
  /** Whether it keeps its history (`@Application({ retention: { executionRecords } })`). */
  readonly isKept: boolean;
  readonly history: ExecutionHistoryRepository;
  /** Stops and destroys what was created (the SQLite connection). */
  readonly close: () => Promise<void>;
}

/** Opens the execution history of `application` under its `profile`. */
export async function openExecutionHistory(
  application: Class,
  options: Pick<BuildApplicationOptions, "profile" | "processEnv"> = {},
): Promise<OpenedExecutionHistory> {
  const processEnv = options.processEnv ?? process.env;
  const assembled = await applicationOf(
    application,
    { profile: options.profile, processEnv, withoutIdempotencyKeys: true },
    "agboss executions export",
  );
  const created: unknown[] = [];
  const onCreate = (instance: unknown): void => {
    created.push(instance);
  };
  const clock = clockOf(assembled.modules, { onCreate });
  const contexts = contextsOf(assembled, options, {}, clock);
  const storage = resolvedStorageOf(assembled.storage, processEnv);
  const sources = { modules: assembled.modules, clock, contexts, storage };
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
