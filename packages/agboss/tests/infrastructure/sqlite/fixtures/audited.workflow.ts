import { WorkflowStartTextDto } from "../../../../src/dto/index.js";
import {
  ApplicationContext,
  Clock,
  IdGenerator,
  Injectable,
  SqliteCheckpointSaver,
  SqliteConnection,
  SqliteExecutionRecordRepository,
  Workflow,
  type NewThread,
} from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { start } from "../../../helpers/flow.js";
import {
  Clerk,
  OrderWorkflowStart,
  ReceiptDto,
  ReceiptWorkflowFinish,
} from "../../fixtures/recovery.workflow.js";
import { SqliteTestEnvironment } from "./environments/app.environment.js";

/** What the project's records repository saw: the threads it created, on which instance. */
export const audited: { threads: string[]; instances: string[] } = { threads: [], instances: [] };

export function resetAudit(): void {
  audited.threads = [];
  audited.instances = [];
}

/**
 * #313 AC1 — a project's own records repository: `SqliteExecutionRecordRepository` subclassed
 * through public tokens only (`agboss`: `SqliteConnection`, `Clock`, `ApplicationContext`,
 * `IdGenerator`), its thread ids from the application's `IdGenerator`.
 */
@Injectable({ deps: [SqliteConnection, Clock, ApplicationContext, IdGenerator] })
export class AuditedSqliteExecutionRecordRepository extends SqliteExecutionRecordRepository {
  readonly #instanceId: string;

  constructor(
    connection: SqliteConnection,
    clock: Clock,
    applicationContext: ApplicationContext,
    idGenerator: IdGenerator,
  ) {
    super(connection, clock, applicationContext, idGenerator);
    this.#instanceId = applicationContext.instanceId;
  }

  override async createThread(thread: NewThread): Promise<string> {
    const threadId = await super.createThread(thread);
    audited.threads.push(threadId);
    audited.instances.push(this.#instanceId);
    return threadId;
  }
}

/** The recovery fixture's clerk in a workflow of its own. */
@Workflow({
  name: "audited-note-workflow",
  version: "1.0.0",
  defaults: {
    models: { maxTokens: 100, temperature: 0 },
    tools: { maxToolCalls: 8 },
  },
  flow: [
    start(OrderWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(Clerk)
      .returns(ReceiptDto)
      .toFinish(ReceiptWorkflowFinish),
  ],
})
export class AuditedNoteWorkflow {}

@Application({
  name: "audited-records-application",
  version: "1.0.0",
  environment: SqliteTestEnvironment,
  workflows: [AuditedNoteWorkflow],
  providers: [AuditedSqliteExecutionRecordRepository, SqliteCheckpointSaver],
  budgets: TEST_BUDGETS,
})
export class AuditedRecordsApplication {}
