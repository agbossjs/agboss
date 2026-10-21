/**
 * #313 AC1: a project subclasses `SqliteExecutionRecordRepository` through public tokens only —
 * `@Injectable({ deps: [SqliteConnection, Clock, ApplicationContext, IdGenerator] })`, no internal
 * token — lists it in `@Application({ providers })`, and it creates the threads: their ids from the
 * application's `IdGenerator` (`thread-1`, … under `testWith`; random UUIDs in `createApp`), kept
 * in the SQLite file.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../../src/application/create-app.js";
import { replyWith, testWith } from "../../../src/testing/index.js";
import { ScriptBook } from "../../../src/testing/script-book.js";
import { createScriptedGateway } from "../../../src/testing/scripted-gateway.js";
import { execute } from "../../helpers/flow.js";
import {
  Clerk,
  OrderWorkflowStart,
  ReceiptDto,
  resetRecovery,
} from "../fixtures/recovery.workflow.js";
import { AuditedRecordsApplication, audited, resetAudit } from "./fixtures/audited.workflow.js";
import { sqliteFilePerTest } from "./fixtures/sqlite.workflow.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

sqliteFilePerTest();
const test = testWith(AuditedRecordsApplication);

beforeEach(() => {
  resetRecovery();
  resetAudit();
});

describe("#313 AC1: a project's SqliteExecutionRecordRepository, public tokens only", () => {
  test("listed in providers, it creates the threads — their ids from the IdGenerator, in the file", async ({
    app,
    mockLlm,
    recoverApp,
  }) => {
    mockLlm(Clerk).thenReturn(
      replyWith(ReceiptDto, { text: "One." }),
      replyWith(ReceiptDto, { text: "Two." }),
      replyWith(ReceiptDto, { text: "Three." }),
    );

    const first = await execute(app, OrderWorkflowStart, { text: "note one" });
    const second = await execute(app, OrderWorkflowStart, { text: "note two" });
    // a restart reads the thread back from the file: continued, not created again
    const restarted = await recoverApp();
    const continued = await execute(
      restarted,
      OrderWorkflowStart,
      { text: "note three" },
      { threadId: first.threadId },
    );

    expect(audited.threads).toEqual(["thread-1", "thread-2"]);
    expect(audited.instances).toEqual(["instance-1", "instance-1"]);
    expect([first.threadId, second.threadId, continued.threadId]).toEqual([
      "thread-1",
      "thread-2",
      "thread-1",
    ]);
    expect([first.executionId, second.executionId, continued.executionId]).toEqual([
      "execution-1",
      "execution-2",
      "execution-3",
    ]);
  });

  it("in createApp its thread ids are the built-in random ones, the format unchanged", async () => {
    const book = new ScriptBook();
    book.scriptOf("agent:clerk-agent").thenReturn(replyWith(ReceiptDto, { text: "One." }));
    const app = await createApp(AuditedRecordsApplication, {
      env: "test",
      gateway: createScriptedGateway(book),
    });
    try {
      const result = await execute(app, OrderWorkflowStart, { text: "note one" });

      expect(audited.threads).toEqual([result.threadId]);
      expect(result.threadId).toMatch(UUID);
      expect(result.executionId).toMatch(UUID);
    } finally {
      await app.close();
    }
  });
});
