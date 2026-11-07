/**
 * #511 AC3: a class declares the environment fields it reads — `@Injectable({ environmentFields })`
 * — and an application that lists it, or lists a class whose `deps` reach it (a store and its
 * connection), fails assembly with `[environment.missing-field]` when its contract lacks a required
 * one, naming the field and the class, the way `sqlitePath` always did; `SqliteConnection` declares
 * `sqlitePath` the same way.
 */
import { describe, expect, it } from "vitest";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import type { Class } from "../../src/components/injection.js";
import {
  ApplicationContext,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  EnvironmentField,
  GraphRuleError,
  Injectable,
  Secret,
  SqliteConnection,
} from "../../src/index.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { depsOf } from "../../src/components/container/container.js";
import { readingClassesOf } from "../../src/environments/contract.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { RecoveryWorkflow } from "../infrastructure/fixtures/recovery.workflow.js";
import { start } from "../helpers/flow.js";

/** A store's connection: what it reads from the environment. */
@Injectable({
  deps: [ApplicationContext],
  environmentFields: {
    postgresUrl: EnvironmentField.secret(),
    postgresPoolSize: EnvironmentField.integer({ optional: true }),
  },
})
class PostgresLikeConnection {
  constructor(readonly applicationContext: ApplicationContext) {}
}

/** A store reaching the connection through its deps: what an application lists. */
@Injectable({ deps: [PostgresLikeConnection] })
class PostgresLikeLeaseStore {
  constructor(readonly connection: PostgresLikeConnection) {}
}

/** A class that reads `postgresUrl` as text, not a secret. */
@Injectable({ environmentFields: { postgresUrl: EnvironmentField.text() } })
class TextUrlReader {}

@WorkflowStart({
  name: "connected-workflow-start",
  description: "A text",
  input: WorkflowStartTextDto,
})
class ConnectedStart {}

@WorkflowFinish({
  name: "connected-workflow-finish",
  description: "Done",
  output: WorkflowFinishTextDto,
})
class ConnectedFinish {}

/** A workflow whose own providers reach the connection. */
@Workflow({
  name: "connected-workflow",
  version: "1.0.0",
  flow: [start(ConnectedStart).returns(WorkflowStartTextDto).toFinish(ConnectedFinish)],
  providers: [PostgresLikeLeaseStore],
})
class ConnectedWorkflow {}

/** A contract without the store's fields. */
class BareEnvironment {
  region!: string;
}

/** A contract with the required field, without the optional one. */
class PostgresEnvironment {
  postgresUrl!: Secret;
}

const applicationListing = (
  name: string,
  environment: Class,
  providers: readonly Class[],
  workflows: readonly Class[] = [RecoveryWorkflow],
): Class => {
  @Application({ name, version: "1.0.0", environment, workflows, providers, budgets: TEST_BUDGETS })
  class ListingApplication {}
  return ListingApplication;
};

async function violationsOf(application: Class): Promise<string[]> {
  const error: unknown = await applicationOf(application).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof GraphRuleError)) return [];
  return error.violations.map((found) => `[${found.code}] ${found.message}`);
}

describe("#511 AC3: a declared environment field is checked at assembly", () => {
  it("AC3: a listed class's declared field missing from the contract → [environment.missing-field]", async () => {
    const listing = applicationListing("direct-application", BareEnvironment, [
      PostgresLikeConnection,
    ]);

    expect(await violationsOf(listing)).toEqual([
      "[environment.missing-field] PostgresLikeConnection needs postgresUrl: Secret in BareEnvironment",
    ]);
  });

  it("AC3: a class whose deps reach it fails the same, naming the class that reads the field", async () => {
    const listing = applicationListing("reached-application", BareEnvironment, [
      PostgresLikeLeaseStore,
    ]);

    expect(await violationsOf(listing)).toEqual([
      "[environment.missing-field] PostgresLikeLeaseStore needs postgresUrl: Secret in BareEnvironment (read by PostgresLikeConnection)",
    ]);
  });

  it("AC3: a workflow's provider is checked too", async () => {
    const listing = applicationListing(
      "workflow-application",
      BareEnvironment,
      [],
      [ConnectedWorkflow],
    );

    expect(await violationsOf(listing)).toContain(
      "[environment.missing-field] PostgresLikeLeaseStore needs postgresUrl: Secret in BareEnvironment (read by PostgresLikeConnection)",
    );
  });

  it("AC3: an optional declared field absent from the contract → no error", async () => {
    const listing = applicationListing("optional-application", PostgresEnvironment, [
      PostgresLikeLeaseStore,
    ]);

    expect(await violationsOf(listing)).toEqual([]);
  });

  it("AC3: one field declared by two classes with different types → [environment.conflicting-field]", async () => {
    const listing = applicationListing("conflicting-application", PostgresEnvironment, [
      PostgresLikeLeaseStore,
      TextUrlReader,
    ]);

    expect(await violationsOf(listing)).toEqual([
      "[environment.conflicting-field] PostgresLikeConnection reads postgresUrl as Secret, TextUrlReader as string — one field has one type; rename one of them",
    ]);
  });

  it("AC3: SqliteConnection declares sqlitePath; a class without declared fields reads nothing", async () => {
    const listing = applicationListing("sqlite-application", BareEnvironment, [SqliteConnection]);

    expect(await violationsOf(listing)).toEqual([
      "[environment.missing-field] SqliteConnection needs sqlitePath: string in BareEnvironment",
    ]);
    expect(
      await violationsOf(
        applicationListing("plain-application", BareEnvironment, [
          InMemoryExecutionLeaseRepository,
        ]),
      ),
    ).toEqual([]);
  });

  it("AC3: what reads the environment is each listed class and every class its deps reach, once", () => {
    expect(readingClassesOf([PostgresLikeLeaseStore, PostgresLikeLeaseStore], depsOf)).toEqual([
      { listed: PostgresLikeLeaseStore, reader: PostgresLikeLeaseStore },
      { listed: PostgresLikeLeaseStore, reader: PostgresLikeConnection },
      { listed: PostgresLikeLeaseStore, reader: ApplicationContext },
    ]);
  });
});

describe("#834 AC3: environment fields are made by EnvironmentField's helpers, their names checked", () => {
  const declared = (fields: unknown): Class => {
    class Reader {
      readonly name = "reader";
    }
    return Injectable({ environmentFields: fields as Record<string, EnvironmentField> })(Reader);
  };

  it("each helper is a type, optional or not", async () => {
    @Injectable({
      environmentFields: {
        auditUrl: EnvironmentField.text(),
        auditRetries: EnvironmentField.integer(),
        auditOn: EnvironmentField.flag({ optional: true }),
        auditKey: EnvironmentField.secret({ optional: false }),
      },
    })
    class AuditReader {}

    expect(
      await violationsOf(applicationListing("audit-application", BareEnvironment, [AuditReader])),
    ).toEqual([
      "[environment.missing-field] AuditReader needs auditUrl: string in BareEnvironment",
      "[environment.missing-field] AuditReader needs auditRetries: number in BareEnvironment",
      "[environment.missing-field] AuditReader needs auditKey: Secret in BareEnvironment",
    ]);
  });

  it("a literal or a string does not compile, and is refused at decoration", () => {
    // @ts-expect-error — a field is made by EnvironmentField's helpers only
    const literal: EnvironmentField = { type: "Secret", isOptional: false };
    expect(() => declared({ postgresUrl: literal })).toThrow(
      "@Injectable({ environmentFields }) of Reader: postgresUrl is an object, not a field made by EnvironmentField.text(), .integer(), .flag() or .secret()",
    );
    // the 0.1.0-era enum value of a JavaScript caller
    expect(() => declared({ postgresUrl: "secret" })).toThrow(
      'postgresUrl is "secret", not a field made by EnvironmentField',
    );
    expect(() => declared({ postgresUrl: undefined })).toThrow(
      /postgresUrl is undefined, not a field/,
    );
  });

  it.each(["PostgresUrl", "postgres-url", "postgres_url", "", "1url"])(
    'a key "%s" is not a field name',
    (field) => {
      expect(() => declared({ [field]: EnvironmentField.secret() })).toThrow(
        `"${field}" is not a field name — a field of the environment contract is a camelCase identifier (postgresUrl)`,
      );
    },
  );

  it.each([{ optinal: true }, { optional: "yes" }, null])(
    "a helper's options %o are named, never read as a required field",
    (options) => {
      expect(() => EnvironmentField.text(options as never)).toThrow(
        "its options are { optional?: boolean } — EnvironmentField.text({ optional: true })",
      );
    },
  );

  it("the helper itself, not called, is named as such", () => {
    expect(() => declared({ postgresUrl: EnvironmentField.secret })).toThrow(
      "postgresUrl is a helper, not a field — call it: EnvironmentField.text(), .integer(), .flag() or .secret()",
    );
  });

  it("environmentFields that is not an object is refused", () => {
    expect(() => declared(null)).toThrow(/environmentFields \}\) of Reader: null is not an object/);
  });
});
