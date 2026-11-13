/**
 * #906 D4: a stored paused run that cannot be read is refused by name — its ids and the field that
 * failed, the schema's error as the `cause` — never with the run in the message: its `startInput`
 * and `data` are the caller's (PII), and a message reaches the logs.
 */
import { describe, expect, it } from "vitest";
import { SqlitePausedExecutionRepository } from "../../../src/infrastructure/sqlite/sqlite-paused-execution.repository.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";

const clock = new VirtualClock(new Date(0));
const SECRET = "ssn-078-05-1120";

/** A store holding one stored run, written as given (a damaged one, or a 0.1.0 one). */
function storeWith(
  run: Record<string, unknown>,
  edit: (json: string) => string = (json) => json,
): SqlitePausedExecutionRepository {
  const path = temporarySqlitePath();
  // the repository makes its table; a second connection writes the row a store write never makes
  const store = new SqlitePausedExecutionRepository(connectionTo(path), clock);
  const connection = connectionTo(path);
  connection.database
    .prepare(
      `INSERT INTO paused_executions (tenant_id, thread_id, run_id, run, workflow_version, config_hash, paused_at)
       VALUES ('acme', 'thread-1', 'run-1', ?, '1.0.0', 'hash', '1970-01-01T00:00:00.000Z')`,
    )
    .run(edit(JSON.stringify(run)));
  return store;
}

const failureOf = async (store: SqlitePausedExecutionRepository): Promise<Error> => {
  const thrown: unknown = await Promise.resolve()
    .then(() => store.findByTenantIdAndThreadId("acme", "thread-1"))
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  expect(thrown).toBeInstanceOf(Error);
  return thrown as Error;
};

describe("#906 D4: an unreadable stored paused run names ids and a field, not the run", () => {
  const run = {
    status: "paused",
    threadId: "thread-1",
    tenantId: "acme",
    runId: "run-1",
    budgetUsd: 1,
    startInput: { ssn: SECRET },
    data: { note: SECRET },
  };

  it("a run without its record's id: the message names the ids and `turnId`, nothing of the input", async () => {
    const error = await failureOf(storeWith(run));

    expect(error.message).toContain("a stored paused run is not readable");
    expect(error.message).not.toContain("tenantId");
    expect(error.message).toContain("threadId thread-1");
    expect(error.message).toContain("runId run-1");
    expect(error.message).toContain("turnId");
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain("startInput");
    expect(JSON.stringify(error.cause ?? "")).not.toContain(SECRET);
  });

  it("a run with another failing field: that field is named, the schema's error is the cause", async () => {
    const error = await failureOf(storeWith({ ...run, turnId: "turn-1", status: "running" }));

    expect(error.message).toContain("the field(s) status");
    expect(error.message).not.toContain(SECRET);
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).message).not.toContain(SECRET);
  });

  it("a stored text that is not JSON: typed, names the ids, nothing of the text, no parser message", async () => {
    // one character of a real stored run edited: `startInput` is left unterminated
    const error = await failureOf(storeWith(run, (json) => json.replace(`"${SECRET}"`, SECRET)));

    expect(error.message).toContain("a stored paused run is not readable");
    expect(error.message).toContain("threadId thread-1");
    expect(error.message).toContain("runId run-1");
    expect(error).not.toBeInstanceOf(SyntaxError);
    for (let link: unknown = error; link instanceof Error; link = link.cause) {
      expect(link.message).not.toContain(SECRET);
      expect(link.message).not.toContain("startInput");
      expect(link.message).not.toContain("JSON.parse");
      expect(link).not.toBeInstanceOf(SyntaxError);
    }
  });

  it("a run stored by 0.1.0 under `ternId` is still read", async () => {
    const store = storeWith({ ...run, ternId: "turn-0" });

    expect((await store.findByTenantIdAndThreadId("acme", "thread-1"))?.run).toMatchObject({
      turnId: "turn-0",
    });
  });
});
