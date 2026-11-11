/**
 * #860 AC3 — fail closed at assembly: a direct-reply skill (`A2AReply.Message`) is stateless — a
 * pause, a fenced effect or an outbound call (through any service a node or a tool injects), a tool
 * that is not `readOnly`, an `@McpTool`, an undo or a child workflow is `[a2a.message-skill-*]`, all
 * at once; a reply for no export and a `defaultSkill` of none are refused; and its replies are kept
 * on its task store's backend — `[a2a.message-store-not-shared]` otherwise, a multi-instance set
 * on shared leases included.
 */
import { describe, expect, it } from "vitest";
import { A2AReply } from "../../../src/a2a/a2a-expose.decorator.js";
import { applicationOf } from "../../../src/application/assemble.js";
import type { Class, Provider } from "../../../src/components/injection.js";
import { GraphRuleError } from "../../../src/graph/rule-error.js";
import { SqliteA2ADirectMessageRepository } from "../../../src/infrastructure/sqlite/sqlite-a2a-direct-message.repository.js";
import { SqliteA2ATaskRepository } from "../../../src/infrastructure/sqlite/sqlite-a2a-task.repository.js";
import { SqliteExecutionLeaseRepository } from "../../../src/index.js";
import { TckWorkflowStart } from "../../a2a-tck/tck.application.js";
import { PostgresA2ATasks } from "../fixtures/a2a-task-stores.fixture.js";
import { BusyWorkflowStart, directRulesApplication } from "../fixtures/direct-rules.fixture.js";
import { QuoteWorkflowStart } from "../fixtures/direct.application.js";

/** The rule violations assembling the application reports: `[]` when it assembles. */
async function violationsOf(application: Class): Promise<readonly string[]> {
  try {
    await applicationOf(application);
    return [];
  } catch (error) {
    if (!(error instanceof GraphRuleError)) throw error;
    return error.violations.map((found) => `[${found.code}] ${found.message}`);
  }
}

const codesOf = (violations: readonly string[]): string[] =>
  violations.map((found) => /^\[([^\]]+)\]/.exec(found)?.[1] ?? found);

describe("#860 AC3: a direct-reply skill is stateless", () => {
  it("AC3: a pause — a question step of its workflow — is [a2a.message-skill-pause]", async () => {
    const violations = await violationsOf(directRulesApplication(TckWorkflowStart));

    expect(violations).toEqual([
      expect.stringMatching(
        /^\[a2a\.message-skill-pause\] tck-workflow-start answers with a direct message \(A2AReply\.Message\) and must be stateless, but tck-input-question asks its caller — answer with a task/,
      ),
    ]);
  });

  it("AC3: every other kind of state, each once and all at once", async () => {
    const violations = await violationsOf(directRulesApplication(BusyWorkflowStart));

    expect(codesOf(violations).sort()).toEqual([
      "a2a.message-skill-child",
      "a2a.message-skill-compensation",
      "a2a.message-skill-effect",
      "a2a.message-skill-effect",
      "a2a.message-skill-tool",
      "a2a.message-skill-tool",
    ]);
    const text = violations.join("\n");
    expect(text).toContain("ChargeAction injects OutboundCalls");
    // two hops down a tool's services: the readOnly flag does not hide it
    expect(text).toContain("LedgerReadTool injects FencedEffectRepository");
    expect(text).toContain("busy-agent calls PingTool, which is not @Tool({ readOnly: true })");
    expect(text).toContain("busy-agent calls BoardLookupTool, an @McpTool");
    expect(text).toContain("reserve-action declares its undo");
    expect(text).toContain("it launches quote-workflow");
    // the read-only tool is allowed
    expect(text).not.toContain("PriceLookupTool");
  });

  it("AC3: the same workflow answering with tasks is not checked", async () => {
    const skills = { "busy-workflow-start": { reply: A2AReply.Task } };

    expect(await violationsOf(directRulesApplication(BusyWorkflowStart, [], skills))).toEqual([]);
  });

  it("AC3: a reply set for no export, and a defaultSkill that is no export, are refused", async () => {
    const skills = { "quote-workflow-startt": { reply: A2AReply.Message } };
    const application = directRulesApplication(BusyWorkflowStart, [], skills, QuoteWorkflowStart);

    const violations = await violationsOf(application);

    expect(violations).toEqual(
      expect.arrayContaining([
        "[a2a.message-skill-unknown] rules-a2a-expose sets the reply of quote-workflow-startt, which it does not export — name an exported start",
        "[a2a.default-skill-unknown] rules-a2a-expose's defaultSkill QuoteWorkflowStart is not one of its exports",
      ]),
    );
  });
});

describe("#860 AC3: the replies are kept on the task store's backend", () => {
  const storesOf = async (providers: readonly Provider[]) =>
    (await violationsOf(directRulesApplication(BusyWorkflowStart, providers, BUSY_AS_TASK))).filter(
      (found) => found.startsWith("[a2a.message-store"),
    );
  // the stores' rule alone: the busy workflow answers with tasks, a quote skill with messages
  const BUSY_AS_TASK = {
    "busy-workflow-start": { reply: A2AReply.Task },
  };

  it("AC3: an application with no direct-reply skill keeps its stores as it likes", async () => {
    expect(await storesOf([SqliteA2ATaskRepository])).toEqual([]);
  });

  it("AC3: one instance, SQLite tasks, the in-memory default for the replies: refused too", async () => {
    const violations = await violationsOf(
      directRulesApplication(TckWorkflowStart, [SqliteA2ATaskRepository]),
    );

    expect(codesOf(violations)).toContain("a2a.message-store-not-shared");
  });

  it("AC3: on shared leases, a direct store apart from the task store is refused, naming the one to list", async () => {
    const application = directRulesApplication(TckWorkflowStart, [
      SqliteExecutionLeaseRepository,
      SqliteA2ATaskRepository,
    ]);

    const violations = await violationsOf(application);

    expect(violations).toContain(
      '[a2a.message-store-not-shared] rules-application answers direct A2A messages (rules-a2a-expose) from InMemoryA2ADirectMessageRepository (backend "in-memory"), but keeps its A2A tasks in SqliteA2ATaskRepository (backend "sqlite"): a message\'s id is claimed among its tasks\' messages, so a resend or a task message of the same id would run the skill again — list SqliteA2ADirectMessageRepository in @Application({ providers })',
    );
  });

  it("AC3: a PostgreSQL task store names the PostgreSQL direct store; SQLite beside SQLite assembles", async () => {
    const onPostgres = await violationsOf(
      directRulesApplication(TckWorkflowStart, [PostgresA2ATasks]),
    );
    const onSqlite = await violationsOf(
      directRulesApplication(TckWorkflowStart, [
        SqliteExecutionLeaseRepository,
        SqliteA2ATaskRepository,
        SqliteA2ADirectMessageRepository,
      ]),
    );

    expect(onPostgres.join("\n")).toContain(
      "list PostgresA2ADirectMessageRepository (@agboss/postgres) in @Application({ providers })",
    );
    expect(codesOf(onSqlite)).toEqual(["a2a.message-skill-pause"]);
  });
});
