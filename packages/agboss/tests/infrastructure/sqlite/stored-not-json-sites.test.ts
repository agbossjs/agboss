/**
 * #1166 (#1121, #906 D4-b): every other core read of a stored text that is no JSON is the coded
 * `StoreError.UnreadableRecord` (`code: "store.unreadable-record"`, the record, the row's ids) and quotes no
 * stored text — not in the message, the stack or the cause. A site that goes back to a bare
 * `JSON.parse` fails its case: the parser's `SyntaxError` quotes the planted secret and has no code.
 */
import { StoreError } from "../../../src/core/error-families/store-errors.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { acceptedOf } from "../../../src/a2a/client/a2a-message.js";
import { reconciliationOf } from "../../../src/a2a/client/a2a-reconcile.js";
import { replayed } from "../../../src/app/outbound-call-endings.js";
import { resumeMapOf } from "../../../src/flow/runtime/child-own-thread.js";
import { decodedRun } from "../../../src/flow/runtime/remote/remote-child-run.js";
import { remoteFailureOf } from "../../../src/flow/runtime/remote/remote-failure.js";
import { LocalDiskFileRepository } from "../../../src/infrastructure/local-disk-file.repository.js";
import {
  ownerOfEntryBody,
  storedMetadataOf,
} from "../../../src/infrastructure/s3/s3-file-layout.js";
import { SqliteExecutionAuditLogRepository } from "../../../src/infrastructure/sqlite/sqlite-execution-audit-log.repository.js";
import { SqliteExecutionTreeRepository } from "../../../src/infrastructure/sqlite/sqlite-execution-tree.repository.js";
import { SqliteFencedEffectRepository } from "../../../src/infrastructure/sqlite/sqlite-fenced-effect.repository.js";
import { SqliteExecutionLeaseRepository } from "../../../src/infrastructure/sqlite/sqlite-execution-lease.repository.js";
import { SqliteMeshRequestRepository } from "../../../src/infrastructure/sqlite/sqlite-mesh-request.repository.js";
import { SqliteOutboundCallRepository } from "../../../src/infrastructure/sqlite/sqlite-outbound-call.repository.js";
import { directMessageOf } from "../../../src/infrastructure/sqlite/sqlite-a2a-direct-message-rows.js";
import { messageOf, taskOf } from "../../../src/infrastructure/sqlite/sqlite-a2a-task-rows.js";
import { toMailbox } from "../../../src/infrastructure/sqlite/sqlite-pause-notice-schema.js";
import { NO_ENVIRONMENT_VALUES } from "../../../src/environments/resolve.js";
import { applicationContextOf } from "../../../src/flow/context/application-context.js";
import { businessKeyOf, keyOf } from "../../../src/testing/contracts/fenced-effect-data.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { hours } from "../../../src/units/index.js";
import { connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";
import { storeClockOf } from "../../helpers/store-clock.js";

const SECRET = "ssn-078-05-1166";
/**
 * Texts that are no JSON. A parser quotes the text around where it failed: the bare secret and the
 * one that breaks at the secret are quoted whole, the first only as its tail.
 */
const TEXTS: readonly (readonly [string, string])[] = [
  ["a text that breaks after the secret", `{"startInput":{"name":"${SECRET}"},"x":undefined}`],
  ["a bare secret", SECRET],
  ["a text that breaks at the secret", `{"startInput":{"name":${SECRET}}}`],
];

/** The error `read` throws (a promise rejects as it throws). */
async function thrownBy(read: () => unknown): Promise<unknown> {
  return Promise.resolve()
    .then(read)
    .then(
      () => new Error("it was read"),
      (thrown: unknown) => thrown,
    );
}

/** The refusal: the coded class, its record and ids, a cause of no text, no text anywhere. */
async function refused(read: () => unknown, record: string, ids: string): Promise<void> {
  const error = await thrownBy(read);
  expect(error).toBeInstanceOf(StoreError.UnreadableRecord);
  if (!(error instanceof StoreError.UnreadableRecord)) throw new TypeError("not the coded error");
  expect(error.code).toBe("store.unreadable-record");
  expect(error.record).toBe(record);
  expect(error.ids).toBe(ids);
  expect(error.message).toContain("not valid JSON");
  expect(error.cause).toBeInstanceOf(SyntaxError);
  const shown = inspect(error, { depth: 12 });
  expect(shown).not.toContain(SECRET);
  expect(shown).not.toContain("startInput");
  expect(shown).not.toMatch(/Unexpected|JSON\.parse/);
}

const iso = "2026-01-05T09:00:00.000Z";
const folders: string[] = [];
afterAll(() => {
  for (const each of folders) rmSync(each, { recursive: true, force: true });
});

describe.each(TEXTS)("#1166: %s is the coded unreadable refusal", (_name, NOT_JSON) => {
  it("an outbound call's stored result (endings)", async () => {
    await refused(
      () =>
        replayed(
          { key: { name: "charge" }, options: {}, parts: {} } as never,
          { result: NOT_JSON } as never,
        ),
      "outbound call result",
      "name charge",
    );
  });

  it("a mesh request's response", async () => {
    const connection = connectionTo(temporarySqlitePath());
    const mesh = new SqliteMeshRequestRepository(connection);
    const key = { tenantId: "default", peer: "peer-1", idempotencyKey: "key-1" };
    await mesh.saveIfAbsent({
      ...key,
      tool: "t",
      requestHash: "h",
      createdAt: iso,
      attemptId: "a",
      expiresAt: iso,
      lockedUntil: iso,
    });
    await mesh.saveResponse(key, "a", "ok");
    connection.database.prepare("UPDATE mesh_requests SET response = ?").run(NOT_JSON);

    await refused(
      () => mesh.findByKey(key),
      "mesh request response",
      "peer peer-1, idempotencyKey key-1",
    );
  });

  it("an a2a task's status, and an a2a message's reply", async () => {
    const task = {
      endpoint: "orders-a2a-expose",
      tenant_id: "default",
      task_id: "task-1",
      owner_id: "",
      context_id: "c-1",
      skill: "s",
      state: "TASK_STATE_WORKING",
      status: NOT_JSON,
      version: 1,
      accepted_at: iso,
      status_at: iso,
      caller_peer: null,
      mesh_body_hash: null,
    };
    const message = {
      endpoint: "orders-a2a-expose",
      tenant_id: "default",
      owner_id: "",
      message_id: "message-1",
      request_hash: "h",
      task_id: "task-1",
      saved_at: iso,
      reply: NOT_JSON,
    };

    await refused(() => taskOf(task), "a2a task status", "taskId task-1");
    await refused(() => messageOf(message), "a2a message reply", "messageId message-1");
  });

  it("an a2a direct message's reply", async () => {
    const row = {
      endpoint: "orders-a2a-expose",
      tenant_id: "default",
      owner_id: "",
      message_id: "message-1",
      request_hash: "h",
      skill: "s",
      context_id: "c-1",
      state: "completed",
      attempt_id: "a-1",
      calls_model: 0,
      created_at: iso,
      started_at: iso,
      expires_at: iso,
      caller_peer: null,
      mesh_body_hash: null,
      reply: NOT_JSON,
      completed_at: iso,
    };

    await refused(() => directMessageOf(row), "a2a direct message reply", "messageId message-1");
  });

  it("an audit event row", async () => {
    const connection = connectionTo(temporarySqlitePath());
    const audit = new SqliteExecutionAuditLogRepository(connection);
    connection.database
      .prepare(
        "INSERT INTO execution_lease_events (tenant_id, root_execution_id, occurred_at, record) VALUES ('default', 'run-1', 1, ?)",
      )
      .run(NOT_JSON);

    await refused(
      () => audit.findAllByTenantIdAndRootExecutionIdOrderByOccurredAt("default", "run-1"),
      "execution audit event",
      "",
    );
  });

  it("an outbound call record", async () => {
    const connection = connectionTo(temporarySqlitePath());
    const calls = new SqliteOutboundCallRepository(connection, storeClockOf(new VirtualClock()));
    connection.database
      .prepare(
        "INSERT INTO outbound_calls (scope_key, idempotency_key, name, tenant_id, root_execution_id, status, expires_at, record, business_key) VALUES ('s', 'i', 'charge', 'default', 'run-1', 'pending', NULL, ?, NULL)",
      )
      .run(NOT_JSON);

    await refused(
      () => calls.findAllByTenantIdAndRootExecutionId("default", "run-1"),
      "outbound call record",
      "",
    );
  });

  it("an execution tree value", async () => {
    const connection = connectionTo(temporarySqlitePath());
    const trees = new SqliteExecutionTreeRepository(connection);
    connection.database
      .prepare("INSERT INTO execution_tree_keys VALUES ('default', 'run-1', 'k1', ?)")
      .run(NOT_JSON);

    await refused(
      () => trees.findByIdInTree({ tenantId: "default", rootExecutionId: "run-1" }, "k1"),
      "execution tree value",
      "key k1",
    );
  });

  it("a fenced effect's stored result, and a business key's facts", async () => {
    const clock = new VirtualClock();
    const connection = connectionTo(temporarySqlitePath());
    const application = applicationContextOf({
      name: "fenced-application",
      version: "1.0.0",
      instanceId: "instance-1",
      startedAt: clock.now(),
      environmentName: "test",
      environment: NO_ENVIRONMENT_VALUES,
    });
    const effects = new SqliteFencedEffectRepository(connection, storeClockOf(clock));
    const leases = new SqliteExecutionLeaseRepository(connection, storeClockOf(clock), application);
    const lease = await leases.acquire("default", "execution-1", hours(1));
    if (lease === undefined) throw new Error("the lease is held");
    const key = keyOf(lease);
    await effects.runOnce(key, () => "done");
    connection.database.prepare("UPDATE fenced_effect_results SET result = ?").run(NOT_JSON);

    await refused(() => effects.runOnce(key, () => "again"), "fenced effect result", "name charge");

    const business = businessKeyOf(lease);
    await effects.runOnce(business, () => "done");
    connection.database
      .prepare("UPDATE fenced_effect_business_results SET facts = ?")
      .run(NOT_JSON);

    await refused(
      () => effects.runOnce(business, () => "again"),
      "fenced effect facts",
      "name charge",
    );
  });

  it("a pause notice mailbox", async () => {
    const row = {
      tenant_id: "default",
      pause_id: "p1",
      recipient: "r",
      notices: NOT_JSON,
      delivered: 0,
      attempts: 0,
      next_attempt_at: iso,
      head_written_at: null,
      is_dead: 0,
      problem: null,
      claim_token: null,
      claimed_until: null,
    };

    await refused(() => toMailbox(row), "pause notice mailbox", "pauseId p1");
  });

  it("an a2a file's metadata on disk", async () => {
    const folder = mkdtempSync(join(tmpdir(), "agboss-1166-files-"));
    folders.push(folder);
    const files = new LocalDiskFileRepository({
      environment: { a2aFilesPath: folder },
    } as never);
    const name = (text: string) => createHash("sha256").update(text).digest("hex");
    mkdirSync(join(folder, name("default")), { recursive: true });
    writeFileSync(join(folder, name("default"), `${name("file-1")}.json`), NOT_JSON);

    await refused(
      () => files.findMetadata({ tenantId: "default", fileId: "file-1" }),
      "a2a file metadata",
      "",
    );
  });

  it("an a2a file's metadata and index entry in an object store", async () => {
    const head = Buffer.from(`${NOT_JSON}\nbytes`);

    await refused(() => storedMetadataOf(head), "a2a file metadata", "");
    await refused(() => ownerOfEntryBody(Buffer.from(NOT_JSON)), "a2a file index entry", "");
  });

  it("an a2a call's stored request, and its stored reply message", async () => {
    await refused(
      () => reconciliationOf({} as never, { storedRequest: NOT_JSON }, "message-1"),
      "a2a call request",
      "",
    );
    await refused(
      () =>
        acceptedOf(
          { kind: "message", message: NOT_JSON, mesh: false } as never,
          undefined,
          false,
          "m",
        ),
      "a2a call reply message",
      "",
    );
  });

  it("a queued child's failure and run, and a forwarded resume map", async () => {
    await refused(() => remoteFailureOf(NOT_JSON), "child failure", "");
    await refused(() => decodedRun({} as never, NOT_JSON), "queued child run", "");
    await refused(() => resumeMapOf(NOT_JSON), "forwarded resume map", "");
  });
});
