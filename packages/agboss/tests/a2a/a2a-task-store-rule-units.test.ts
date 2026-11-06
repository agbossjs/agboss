/**
 * #824 AC3 (mutation shard `a2a-server`): the rule's own texts and edges, from the declarations —
 * each refusal's full message (a listed store, a single-host one, an undeclared lease backend, one
 * no store of the core's names, a second database of one kind), the violation's node, every
 * `@A2AExpose` named; never a refusal for an application serving MCP only, with no exposes, or
 * with two lease stores (their ambiguity is reported, nothing thrown).
 */
import { describe, expect, it } from "vitest";
import { a2aTaskStoreViolations } from "../../src/a2a/a2a-task-store-rule.js";
import { A2AExpose } from "../../src/a2a/a2a-expose.decorator.js";
import { applicationOf } from "../../src/application/assemble.js";
import type { ApplicationOptions } from "../../src/application/application.js";
import type { Provider } from "../../src/components/injection.js";
import { GraphRuleError } from "../../src/graph/rule-error.js";
import { ApplicationContext, Clock, Injectable } from "../../src/index.js";
import { IN_MEMORY_DATABASE } from "../../src/infrastructure/in-memory-database.js";
import { InMemoryA2ATaskRepository } from "../../src/infrastructure/in-memory-a2a-task.repository.js";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { SqliteA2ATaskRepository } from "../../src/infrastructure/sqlite/sqlite-a2a-task.repository.js";
import { McpExpose } from "../../src/mcp/mcp-expose.decorator.js";
import { ReleaseWorkflowStart } from "../app/fixtures/fence.workflow.js";
import {
  BillingLeases,
  PostgresLeases,
  UndeclaredLeases,
} from "../application/fixtures/store-backends.fixture.js";
import {
  a2aStoresApplication,
  OwnInMemoryA2ATasks,
  ReleaseA2AExpose,
} from "./fixtures/a2a-task-stores.fixture.js";

@Injectable({ deps: [Clock, ApplicationContext, IN_MEMORY_DATABASE] })
class CassandraLeases extends InMemoryExecutionLeaseRepository {
  static override readonly backend: string | undefined = "cassandra";
}

@Injectable({ deps: [IN_MEMORY_DATABASE] })
class OtherFileA2ATasks extends InMemoryA2ATaskRepository {
  static override readonly backend: string | undefined = "sqlite:other";
}

@A2AExpose({
  name: "audit-a2a-expose",
  version: "1.0.0",
  description: "Audits",
  exports: [ReleaseWorkflowStart],
})
class AuditA2AExpose {}

@McpExpose({ name: "release-mcp-expose", version: "1.0.0", exports: [ReleaseWorkflowStart] })
class ReleaseMcpExpose {}

class NotAnExpose {
  readonly role = "no expose";
}

/** The rule on declarations alone: an application's name, exposes and providers. */
const ruleOf = (exposes: ApplicationOptions["exposes"], providers?: readonly Provider[]) =>
  a2aTaskStoreViolations({
    name: "rule-application",
    exposes,
    ...(providers === undefined ? {} : { providers }),
  } as ApplicationOptions);

const messageOf = (providers: readonly Provider[]) =>
  ruleOf([ReleaseA2AExpose], providers).map(({ message }) => message);

const SERVES = "rule-application serves A2A (release-a2a-expose) on";
const RESENT = "a message resent to another instance would start a second execution";

describe("#824 AC3: the rule's refusals, word for word", () => {
  it("one violation, on the application, naming every @A2AExpose it serves", () => {
    const [found, ...rest] = ruleOf([ReleaseA2AExpose, AuditA2AExpose], [PostgresLeases]);

    expect(rest).toEqual([]);
    expect(found?.code).toBe("a2a.task-store-not-shared");
    expect(found?.nodes).toEqual(["rule-application"]);
    expect(found?.message).toMatch(
      /^rule-application serves A2A \(release-a2a-expose, audit-a2a-expose\) on /u,
    );
  });

  it("a listed in-memory store, and a single-host one other than the leases'", () => {
    expect(messageOf([PostgresLeases, OwnInMemoryA2ATasks])).toEqual([
      `${SERVES} PostgresLeases (backend "postgres"), which its instances share, but keeps its A2A tasks in OwnInMemoryA2ATasks (backend "in-memory"), each instance's own: ${RESENT} — list PostgresA2ATaskRepository (@agboss/postgres) in @Application({ providers })`,
    ]);
    expect(messageOf([PostgresLeases, SqliteA2ATaskRepository])).toEqual([
      `${SERVES} PostgresLeases (backend "postgres"), which its instances share, but keeps its A2A tasks in SqliteA2ATaskRepository (backend "sqlite"), one host's: ${RESENT} — list PostgresA2ATaskRepository (@agboss/postgres) in @Application({ providers })`,
    ]);
    expect(messageOf([PostgresLeases, OtherFileA2ATasks])).toHaveLength(1);
  });

  it("an undeclared lease backend, one the core names no store of, a second database", () => {
    expect(messageOf([UndeclaredLeases])).toEqual([
      `${SERVES} UndeclaredLeases, which declares no backend, but keeps its A2A tasks in InMemoryA2ATaskRepository (backend "in-memory", the built-in default: none listed), each instance's own: ${RESENT} — declare the lease store's backend (static backend = "postgres") and list an A2A task store on it`,
    ]);
    expect(messageOf([CassandraLeases])[0]).toMatch(
      / — list an A2A task store declaring backend "cassandra" in @Application\(\{ providers \}\)$/u,
    );
    expect(messageOf([BillingLeases])[0]).toMatch(
      / — list PostgresA2ATaskRepository \(@agboss\/postgres\) in @Application\(\{ providers \}\)$/u,
    );
  });
});

describe("#824 AC3: no refusal where no A2A task is served", () => {
  it("MCP only, or no exposes at all, or no providers: nothing", () => {
    expect(ruleOf([ReleaseMcpExpose], [PostgresLeases])).toEqual([]);
    expect(ruleOf(undefined, [PostgresLeases])).toEqual([]);
    expect(ruleOf([ReleaseA2AExpose])).toEqual([]);
  });

  it("an expose that is none: the rule reads past it (assembly names it), nothing thrown", () => {
    expect(ruleOf([NotAnExpose], [PostgresLeases])).toEqual([]);
  });

  it("two lease stores: their ambiguity is reported, the rule adds nothing", async () => {
    const codes = await applicationOf(a2aStoresApplication([PostgresLeases, BillingLeases])).then(
      () => [],
      (error: unknown) => {
        if (!(error instanceof GraphRuleError)) throw error;
        return error.violations.map(({ code }) => code);
      },
    );

    expect(codes).toContain("di.ambiguous-implementation");
    expect(codes).not.toContain("a2a.task-store-not-shared");
    expect(ruleOf([ReleaseA2AExpose], [PostgresLeases, BillingLeases])).toEqual([]);
  });
});
