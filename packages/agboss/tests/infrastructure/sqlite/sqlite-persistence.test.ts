/**
 * #265 PR 3 (#261 S49 b): with the SQLite implementations listed, what one process wrote is there
 * for the next — a thread is continued after a restart (`--thread`), and a workflow run on its own
 * (`agboss eval` / `replay` / `golden`, `createAppDeps`) reads its application's records from the
 * file. Nothing is written outside `sqlitePath`.
 */
import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import { beforeEach, describe, expect } from "vitest";
import { createAppDeps } from "../../../src/app/app-deps.js";
import {
  environmentOwnerOfWorkflow,
  workflowInApplication,
} from "../../../src/application/workflow-application.js";
import { environmentFor } from "../../../src/environments/load.js";
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
import {
  NoteWorkflow,
  SqliteNoteApplication,
  sqliteFilePerTest,
} from "./fixtures/sqlite.workflow.js";

const file = sqliteFilePerTest();
const test = testWith(SqliteNoteApplication);

beforeEach(resetRecovery);

describe("#265 PR 3: records persist across processes on the SQLite file", () => {
  test("a thread is continued after a restart; a workflow run on its own reads its records", async ({
    app,
    mockLlm,
    recoverApp,
  }) => {
    mockLlm(Clerk).thenReturn(
      replyWith(ReceiptDto, { text: "One." }),
      replyWith(ReceiptDto, { text: "Two." }),
    );
    const first = await execute(app, OrderWorkflowStart, { text: "note one" });

    const restarted = await recoverApp();
    const second = await execute(
      restarted,
      OrderWorkflowStart,
      { text: "note two" },
      {
        threadId: first.threadId,
      },
    );
    const environment = await environmentFor(
      environmentOwnerOfWorkflow(NoteWorkflow),
      { env: "test" },
      process.env,
    );
    const standalone = await createAppDeps(await workflowInApplication(NoteWorkflow), {
      ...(environment === undefined ? {} : { environment }),
      gateway: createScriptedGateway(new ScriptBook()),
    });
    const records = await standalone.terns.lastTerns(first.tenantId, first.threadId, 10);
    await standalone.close();

    expect(second.threadId).toBe(first.threadId);
    expect(records.map((record) => record.replyWith)).toHaveLength(2);
    expect(records.map((record) => record.status)).toEqual(["answered", "answered"]);
  });

  test("nothing is written outside sqlitePath: its folder holds the file and its WAL only", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(replyWith(ReceiptDto, { text: "One." }));

    await execute(app, OrderWorkflowStart, { text: "note one" });

    const written = readdirSync(dirname(file.path)).sort();
    expect(written.every((name) => name.startsWith("application.sqlite"))).toBe(true);
    expect(written).toContain("application.sqlite");
  });
});
