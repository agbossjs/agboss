/**
 * #526 AC8 — a store's connection need not be listed: `OutboundCalls` (a service each workflow's
 * container creates) and a component that injects a store's own class reach the store's
 * dependencies through the workflow's graph check, which now takes an unlisted class under an
 * infrastructure implementation as its own registration — as the container creates it. So
 * `SqliteConnection` (and `PostgresConnection`) is created once for the instance without being in
 * `providers`, and the requirement agbossjs/postgres#8 hit is gone. A workflow's own service, an
 * unlisted `InjectionToken` and an undeclared context are refused as before.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import { InjectionToken } from "../../src/components/injection.js";
import { WorkflowStartTextDto } from "../../src/dto/index.js";
import {
  IN_MEMORY_DATABASE,
  type InMemoryDatabase,
} from "../../src/infrastructure/in-memory-database.js";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import {
  Action,
  ApplicationContext,
  Clock,
  Injectable,
  OutboundCallOutcomeStatus,
  OutboundCallStatus,
  SqliteConnection,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
} from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { execute, start } from "../helpers/flow.js";
import { SqliteTestEnvironment } from "../infrastructure/sqlite/fixtures/environments/app.environment.js";
import { sqliteFilePerTest } from "../infrastructure/sqlite/fixtures/sqlite.workflow.js";
import {
  chargesIn,
  SqliteChargeWorkflowStart,
} from "../infrastructure/sqlite/fixtures/sqlite-fenced-effect.workflow.js";
import { ChargeWorkflowStart, resetRuns, runs } from "../app/fixtures/outbound-call.workflow.js";
import { gateway, resetGateway } from "../app/fixtures/payment-gateway.js";
import { book, resetFencedEffect } from "../app/fixtures/fenced-effect.workflow.js";
import {
  ConnectionlessEffectApplication,
  ConnectionlessOutboundApplication,
} from "../infrastructure/sqlite/fixtures/sqlite-connectionless.application.js";

sqliteFilePerTest();

const TREE = { tenantId: "default", rootExecutionId: "execution-1" };

beforeEach(() => {
  resetGateway();
  resetRuns();
  resetFencedEffect();
});

describe("#526 AC8: OutboundCalls on SQLite without SqliteConnection listed", () => {
  it("assembles", async () => {
    const assembled = await applicationOf(ConnectionlessOutboundApplication);

    expect(assembled.providers).not.toContain(SqliteConnection);
  });

  testWith(ConnectionlessOutboundApplication)(
    "a charge is recorded on the file and sent once",
    async ({ app }) => {
      await execute(app, ChargeWorkflowStart, { text: "order-7 alice@example.com" });

      expect(gateway.calls).toHaveLength(1);
      expect(runs.outcomes).toEqual([{ status: OutboundCallOutcomeStatus.Sent, attempt: 1 }]);
      expect(await app.outboundCallsOf(TREE)).toEqual([
        expect.objectContaining({ status: OutboundCallStatus.Completed, token: 1 }),
      ]);
    },
  );

  testWith(ConnectionlessOutboundApplication)(
    "the instance's stores share one connection, created once and ready",
    async ({ app }) => {
      await expect(app.checkReadiness()).resolves.toMatchObject({ status: "healthy" });
    },
  );
});

describe("#526 AC8: a component that injects a store's own class", () => {
  it("assembles without the connection listed", async () => {
    await expect(applicationOf(ConnectionlessEffectApplication)).resolves.toBeDefined();
  });

  testWith(ConnectionlessEffectApplication)(
    "its effect runs once, its row on the file",
    async ({ app }) => {
      await execute(app, SqliteChargeWorkflowStart, { text: "order-1" });

      expect(book.runs).toEqual([{ token: 1, status: "ran" }]);
      const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
      const path = process.env.AGBOSS_SQLITE_TEST_PATH ?? "";
      const database = new DatabaseSync(path);
      try {
        expect(chargesIn(database)).toEqual(["charge-order-1-1"]);
      } finally {
        database.close();
      }
    },
  );
});

/** A connection of a store of a project, with a dependency of its own (also unlisted). */
@Injectable({ deps: [ApplicationContext] })
class OwnPool {
  constructor(readonly application: ApplicationContext) {}
}

@Injectable({ deps: [OwnPool] })
class OwnConnection {
  constructor(readonly pool: OwnPool) {}
}

@Injectable({ deps: [Clock, ApplicationContext, IN_MEMORY_DATABASE, OwnConnection] })
class ConnectedLeases extends InMemoryExecutionLeaseRepository {
  constructor(
    clock: Clock,
    application: ApplicationContext,
    database: InMemoryDatabase,
    readonly connection: OwnConnection,
  ) {
    super(clock, application, database);
  }
}

const POOL_TOKEN = new InjectionToken<string>("POOL_URL");

@Injectable({ deps: [Clock, ApplicationContext, IN_MEMORY_DATABASE, POOL_TOKEN] })
class TokenLeases extends InMemoryExecutionLeaseRepository {
  constructor(
    clock: Clock,
    application: ApplicationContext,
    database: InMemoryDatabase,
    readonly url: string,
  ) {
    super(clock, application, database);
  }
}

/** A workflow's own service, unlisted. */
@Injectable()
class OrderLedger {}

@WorkflowStart({
  name: "lease-reading-workflow-start",
  description: "A text",
  input: WorkflowStartTextDto,
})
class LeaseReadingWorkflowStart {}

@WorkflowFinish({
  name: "lease-read-workflow-finish",
  description: "Done",
  output: WorkflowStartTextDto,
})
class LeaseReadWorkflowFinish {}

/** A workflow whose action reads `store` (a lease store of a project) or a service. */
function workflowReading(dependency: object): object {
  @Action({
    name: "reading-action",
    description: "Reads what it is given",
    input: { message: WorkflowStartTextDto },
    deps: [dependency as typeof OrderLedger],
  })
  class ReadingAction {
    constructor(readonly dependency: unknown) {}

    execute(): Promise<void> {
      return Promise.resolve();
    }
  }

  @Workflow({
    name: "reading-workflow",
    version: "1.0.0",
    flow: [
      start(LeaseReadingWorkflowStart)
        .returns(WorkflowStartTextDto)
        .toAction(ReadingAction)
        .toFinish(LeaseReadWorkflowFinish),
    ],
  })
  class ReadingWorkflow {}
  return ReadingWorkflow;
}

const applicationReading = (dependency: object, providers: readonly object[]) => {
  @Application({
    name: "reading-application",
    version: "1.0.0",
    environment: SqliteTestEnvironment,
    workflows: [workflowReading(dependency) as typeof ConnectionlessEffectApplication],
    budgets: TEST_BUDGETS,
    providers: providers as readonly (typeof OrderLedger)[],
  })
  class ReadingApplication {}
  return ReadingApplication;
};

describe("#526 AC8: what the graph check still refuses, and what it now takes", () => {
  it("a store of a project whose connection and the connection's own dependency are unlisted: assembles", async () => {
    await expect(
      applicationOf(applicationReading(ConnectedLeases, [ConnectedLeases])),
    ).resolves.toBeDefined();
  });

  it("regression: a workflow's own service that nobody lists is still not registered", async () => {
    await expect(applicationOf(applicationReading(OrderLedger, []))).rejects.toThrow(
      'ReadingAction: "OrderLedger" is not registered in @Workflow({ providers })',
    );
  });

  it("an InjectionToken under a store is never its own registration: the store names it", async () => {
    await expect(applicationOf(applicationReading(TokenLeases, [TokenLeases]))).rejects.toThrow(
      'TokenLeases: "POOL_URL" is not registered in @Workflow({ providers })',
    );
  });
});
