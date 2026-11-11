/**
 * #860 AC3 — `[a2a.message-store-not-shared]` in every form: the direct store and the task store
 * declare one backend, or the rule names both and the store to list — for every kind of task store,
 * an undeclared one, one of a kind no rule knows; several exposes named; an application with no
 * direct-reply skill (or no `@A2AExpose` at all) never checked.
 */
import { describe, expect, it } from "vitest";
import { A2AExpose, A2AReply } from "../../../src/a2a/a2a-expose.decorator.js";
import { Application } from "../../../src/application/application.js";
import { applicationOf } from "../../../src/application/assemble.js";
import type { Class, Provider } from "../../../src/components/injection.js";
import { GraphRuleError, type RuleViolation } from "../../../src/graph/rule-error.js";
import { InMemoryA2ADirectMessageRepository } from "../../../src/infrastructure/in-memory-a2a-direct-message.repository.js";
import { IN_MEMORY_DATABASE } from "../../../src/infrastructure/in-memory-database.js";
import { Injectable, type StoreDescriptor } from "../../../src/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { SqliteTestEnvironment } from "../../infrastructure/sqlite/fixtures/environments/app.environment.js";
import {
  LmdbA2ATasks,
  MongoA2ATasks,
  UndeclaredA2ATasks,
} from "../fixtures/a2a-task-stores.fixture.js";
import { QuoteWorkflow, QuoteWorkflowStart } from "../fixtures/direct.application.js";

/** A direct store that declares no backend. */
@Injectable({ deps: [IN_MEMORY_DATABASE] })
class UndeclaredDirectMessages extends InMemoryA2ADirectMessageRepository {
  static override readonly store: StoreDescriptor = { backend: undefined };
}

const exposeOf = (name: string, reply: A2AReply): Class => {
  @A2AExpose({
    name,
    version: "1.0.0",
    description: "Quotes",
    exports: [QuoteWorkflowStart],
    skills: { "quote-workflow-start": { reply } },
  })
  class AnA2AExpose {}
  return AnA2AExpose;
};

const applicationWith = (providers: readonly Provider[], exposes: readonly Class[]): Class => {
  @Application({
    name: "stores-application",
    version: "1.0.0",
    environment: SqliteTestEnvironment,
    workflows: [QuoteWorkflow],
    budgets: TEST_BUDGETS,
    providers,
    exposes,
  })
  class StoresApplication {}
  return StoresApplication;
};

/** The store rule's violations of an application. */
async function storeViolationsOf(application: Class): Promise<readonly RuleViolation[]> {
  try {
    await applicationOf(application);
    return [];
  } catch (error) {
    if (!(error instanceof GraphRuleError)) throw error;
    return error.violations.filter((found) => found.code === "a2a.message-store-not-shared");
  }
}

const DIRECT = [exposeOf("quotes-a2a-expose", A2AReply.Message)];

describe("#860 AC3: [a2a.message-store-not-shared], each form", () => {
  it("AC3: the violation names the application, the stores and the store to list", async () => {
    const found = await storeViolationsOf(applicationWith([MongoA2ATasks], DIRECT));

    expect(found).toEqual([
      {
        code: "a2a.message-store-not-shared",
        message:
          'stores-application answers direct A2A messages (quotes-a2a-expose) from InMemoryA2ADirectMessageRepository (backend "in-memory"), but keeps its A2A tasks in MongoA2ATasks (backend "mongodb"): a message\'s id is claimed among its tasks\' messages, so a resend or a task message of the same id would run the skill again — list MongoA2ADirectMessageRepository (@agboss/mongodb) in @Application({ providers })',
        nodes: ["stores-application"],
      },
    ]);
  });

  it("AC3: both undeclared is refused, never taken as one backend", async () => {
    const found = await storeViolationsOf(
      applicationWith([UndeclaredA2ATasks, UndeclaredDirectMessages], DIRECT),
    );

    expect(found.map((violation) => violation.message)).toEqual([
      "stores-application answers direct A2A messages (quotes-a2a-expose) from UndeclaredDirectMessages, which declares no backend, but keeps its A2A tasks in UndeclaredA2ATasks, which declares no backend: a message's id is claimed among its tasks' messages, so a resend or a task message of the same id would run the skill again — declare the A2A task store's backend and list a direct message store on it",
    ]);
  });

  it("AC3: a task store of a kind no rule knows, and the in-memory task store beside another direct store", async () => {
    const onLmdb = await storeViolationsOf(applicationWith([LmdbA2ATasks], DIRECT));
    const inMemory = await storeViolationsOf(applicationWith([UndeclaredDirectMessages], DIRECT));

    expect(onLmdb[0]?.message).toMatch(
      /— list an A2A direct message store declaring backend "lmdb" in @Application\(\{ providers \}\)$/,
    );
    expect(inMemory[0]?.message).toMatch(
      /— list InMemoryA2ADirectMessageRepository \(the default: list none\) in @Application\(\{ providers \}\)$/,
    );
  });

  it("AC3: several exposes with direct-reply skills are named, comma-separated", async () => {
    const exposes = [
      exposeOf("quotes-a2a-expose", A2AReply.Message),
      exposeOf("prices-a2a-expose", A2AReply.Message),
    ];

    const found = await storeViolationsOf(applicationWith([MongoA2ATasks], exposes));

    expect(found[0]?.message).toContain("(quotes-a2a-expose, prices-a2a-expose)");
  });

  it("AC3: no direct-reply skill — or a class that is no expose — is never checked", async () => {
    const tasksOnly = [exposeOf("quotes-a2a-expose", A2AReply.Task)];
    class NotAnExpose {}

    expect(await storeViolationsOf(applicationWith([MongoA2ATasks], tasksOnly))).toEqual([]);
    expect(await storeViolationsOf(applicationWith([MongoA2ATasks], [NotAnExpose]))).toEqual([]);
  });
});
