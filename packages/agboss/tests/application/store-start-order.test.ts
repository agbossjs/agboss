/**
 * #747 — no store is called before the components the container created have started: a store
 * whose own `onInit` readies it (a PostgreSQL schema checked or migrated, a pool opened) is never
 * used before it. `createApp` writes each workflow's config snapshot (`rememberConfig`, the
 * config-drift warning) only after every `onInit` → `onStart` ran, and the warning is still in
 * `app.warnings` and the start log.
 */
import { createAppWith } from "../../src/application/create-app.js";
import { beforeEach, describe, expect, it } from "vitest";
import { Application } from "../../src/application/application.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { InMemoryExecutionRecordRepository } from "../../src/infrastructure/execution-record.repository.js";
import { TernStoreRecordRepository } from "../../src/infrastructure/execution-record.repository.js";
import {
  Action,
  Clock,
  EmptyEnvironment,
  IdGenerator,
  Injectable,
  LogLevel,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type OnInit,
} from "../../src/index.js";
import { logged, resetLogged, RecordingLogger } from "../helpers/log.js";
import { start } from "../helpers/flow.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";

/** The record store's calls made before its `onInit`, by method name (the test reads it). */
const callsBeforeStart: string[] = [];

/** What `rememberConfig` reports: drift, so the start must warn about it. */
const DRIFT = { drift: true };

/** The methods of the record store's contract, as `TernStoreRecordRepository` implements them. */
const methodNamesOf = (prototype: object): string[] =>
  Object.getOwnPropertyNames(prototype).filter(
    (name) =>
      name !== "constructor" &&
      typeof Object.getOwnPropertyDescriptor(prototype, name)?.value === "function",
  );

/**
 * A record store that is ready only once its `onInit` ran — as one on a database whose schema its
 * connection checks at start. Every call before it is noted; the config snapshot reports drift.
 */
@Injectable({ deps: [Clock, IdGenerator] })
class StartedRecordRepository extends InMemoryExecutionRecordRepository implements OnInit {
  #isStarted = false;

  constructor(clock: Clock, idGenerator: IdGenerator) {
    super(clock, idGenerator);
    for (const name of methodNamesOf(TernStoreRecordRepository.prototype)) {
      const method: unknown = Reflect.get(this, name);
      if (typeof method !== "function") continue;
      Reflect.set(this, name, (...args: unknown[]): unknown => {
        if (!this.#isStarted) callsBeforeStart.push(name);
        const result: unknown = Reflect.apply(
          method as (...given: unknown[]) => unknown,
          this,
          args,
        );
        return result;
      });
    }
  }

  onInit(): void {
    this.#isStarted = true;
  }

  override async rememberConfig(
    ...args: Parameters<TernStoreRecordRepository["rememberConfig"]>
  ): Promise<{ drift: boolean }> {
    await super.rememberConfig(...args);
    return DRIFT;
  }
}

@WorkflowStart({ name: "note-workflow-start", description: "A note", input: WorkflowStartTextDto })
class NoteWorkflowStart {}

@WorkflowFinish({
  name: "note-workflow-finish",
  description: "Noted",
  output: WorkflowFinishTextDto,
})
class NoteWorkflowFinish {}

@Action({
  name: "note-action",
  description: "Notes the text",
  input: { text: WorkflowStartTextDto },
  output: WorkflowFinishTextDto,
})
class NoteAction {
  execute(input: {
    readonly text: { readonly value: WorkflowStartTextDto };
  }): Promise<WorkflowFinishTextDto> {
    return Promise.resolve({ text: input.text.value.text });
  }
}

@Workflow({
  name: "note-workflow",
  version: "1.0.0",
  flow: [
    start(NoteWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAction(NoteAction)
      .returns(WorkflowFinishTextDto)
      .toFinish(NoteWorkflowFinish),
  ],
})
class NoteWorkflow {}

@Application({
  name: "started-stores-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [NoteWorkflow],
  budgets: TEST_BUDGETS,
  providers: [StartedRecordRepository, RecordingLogger],
})
class StartedStoresApplication {}

const DRIFT_WARNING =
  /^config "note-workflow" 1\.0\.0 changed without a version bump \(hash [0-9a-f]{8}\)$/;

beforeEach(() => {
  callsBeforeStart.length = 0;
  resetLogged();
});

describe("#747: no store is called before the components started", () => {
  it("AC1: the record store's first call comes after its onInit", async () => {
    const app = await createAppWith(StartedStoresApplication, { processEnv: {} });
    await app.close();

    expect(callsBeforeStart).toEqual([]);
  });

  it("AC3: the config snapshot is still written at start: its drift is a start warning", async () => {
    const app = await createAppWith(StartedStoresApplication, { processEnv: {} });
    await app.close();

    expect(app.warnings).toContainEqual(expect.stringMatching(DRIFT_WARNING));
    expect(
      logged.filter((entry) => entry.level === LogLevel.Warn).map((entry) => entry.message),
    ).toContainEqual(expect.stringMatching(DRIFT_WARNING));
  });
});
