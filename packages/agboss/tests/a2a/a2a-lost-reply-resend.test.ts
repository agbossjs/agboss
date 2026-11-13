/**
 * #939 AC4 over the real A2A wire, in-memory and SQLite: a resend whose first reply was lost (the kept
 * reply's write failed, a crash has the same effect) still gets the task, whether the task is now
 * terminal or not — never `a2a.task-over`, never a second charge. `task-over` stays the answer to a
 * NEW message to a finished task.
 */
import { beforeEach, describe, expect, vi } from "vitest";
import { A2AExpose } from "../../src/a2a/a2a-expose.decorator.js";
import { A2ASecurity } from "../../src/a2a/a2a-security.js";
import { SqliteA2ATaskRepository } from "../../src/a2a/index.js";
import { Application } from "../../src/application/application.js";
import { A2ATaskRepository } from "../../src/infrastructure/a2a-task.repository.js";
import {
  SqliteCheckpointSaver,
  SqliteCostLedgerRepository,
  SqliteExecutionRecordRepository,
  SqliteExecutionTreeRepository,
  SqlitePausedExecutionRepository,
  SqliteRateLimitRepository,
} from "../../src/index.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import {
  Charge,
  Clerk,
  OrderWorkflowStart,
  ReceiptDto,
  RecoveryLog,
  RecoveryWorkflow,
  resetRecovery,
  seen,
} from "../infrastructure/fixtures/recovery.workflow.js";
import { BearerCallerResolver } from "./fixtures/bearer-caller-resolver.js";
import { OrdersA2AExpose, OrdersApplication } from "./fixtures/task.application.js";
import {
  MortalSqliteExecutionLeaseRepository,
  sqliteFilePerTest,
} from "../infrastructure/sqlite/fixtures/sqlite.workflow.js";
import { SqliteTestEnvironment } from "../infrastructure/sqlite/fixtures/environments/app.environment.js";
import {
  data,
  errorInfoOf,
  errorOf,
  rpc,
  text,
  userMessage,
  type RpcAnswer,
} from "./server/rpc.js";

@A2AExpose({
  name: "ac4-orders-a2a-expose",
  version: "1.0.0",
  description: "Takes orders",
  exports: [OrderWorkflowStart],
  security: [A2ASecurity.bearer()],
})
class SqliteOrdersA2AExpose {}

@Application({
  name: "ac4-sqlite-orders-application",
  version: "1.0.0",
  environment: SqliteTestEnvironment,
  workflows: [RecoveryWorkflow],
  observers: [RecoveryLog],
  providers: [
    MortalSqliteExecutionLeaseRepository,
    SqliteExecutionRecordRepository,
    SqlitePausedExecutionRepository,
    SqliteCheckpointSaver,
    SqliteCostLedgerRepository,
    SqliteExecutionTreeRepository,
    SqliteRateLimitRepository,
    SqliteA2ATaskRepository,
    BearerCallerResolver,
  ],
  exposes: [SqliteOrdersA2AExpose],
  budgets: TEST_BUDGETS,
})
class SqliteOrdersApplication {}

sqliteFilePerTest();
beforeEach(resetRecovery);

interface WireTask {
  readonly id: string;
  readonly status: { readonly state: string };
}
const taskOf = (answer: RpcAnswer): WireTask => {
  const result = answer.body.result as { task?: WireTask } | WireTask | undefined;
  if (result === undefined) throw new Error(`no result: ${JSON.stringify(answer.body)}`);
  return "task" in result && result.task !== undefined ? result.task : (result as WireTask);
};
const approve = (messageId: string, taskId: string) => ({
  message: userMessage(messageId, [data({ decision: { approved: true } })], { taskId }),
});

const CASES = [
  ["in-memory", testWith(OrdersApplication), OrdersA2AExpose],
  ["sqlite", testWith(SqliteOrdersApplication), SqliteOrdersA2AExpose],
] as const;

const LOST = new Error("store down");

for (const [name, test, expose] of CASES) {
  describe(`AC4: a resend whose reply was lost (${name})`, () => {
    test("AC4: an accepted follow-up (task now COMPLETED): the resend gets the task, charged once", async ({
      a2aServer,
      app,
      mockLlm,
    }) => {
      mockLlm(Clerk).thenReturn(
        callTool(Charge, { text: "10 USD" }),
        replyWith(ReceiptDto, { text: "Done." }),
      );
      const { url } = await a2aServer({ expose, callerResolver: BearerCallerResolver });
      const task = taskOf(
        await rpc(url, "SendMessage", { message: userMessage("m-1", [text("go")]) }),
      );
      const tasks = app.resolve(A2ATaskRepository);
      const save = tasks.saveReplyIfAbsent.bind(tasks);
      const lost = vi.spyOn(tasks, "saveReplyIfAbsent").mockRejectedValueOnce(LOST);
      const first = await rpc(url, "SendMessage", approve("m-2", task.id));
      lost.mockImplementation(save);
      expect(errorOf(first).code).toBe(-32603);

      const resent = await rpc(url, "SendMessage", approve("m-2", task.id));
      const another = await rpc(url, "SendMessage", approve("m-3", task.id));

      expect(resent.body.error).toBeUndefined();
      expect(taskOf(resent).status.state).toBe("TASK_STATE_COMPLETED");
      expect(seen.charges).toEqual(["10 USD"]);
      expect(errorInfoOf(another)).toEqual({ code: "a2a.task-over" }); // a NEW message: still over
    });

    test("AC4: a refused follow-up (pause closed by a cancel, task now CANCELED): the resend gets the task", async ({
      a2aServer,
      app,
      mockLlm,
    }) => {
      mockLlm(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
      const { url } = await a2aServer({ expose, callerResolver: BearerCallerResolver });
      const task = taskOf(
        await rpc(url, "SendMessage", { message: userMessage("m-1", [text("go")]) }),
      );
      const resume = app.resume.bind(app);
      const spy = vi.spyOn(app, "resume").mockImplementation(async (request, options) => {
        await rpc(url, "CancelTask", { id: task.id });
        return resume(request, options);
      });
      const tasks = app.resolve(A2ATaskRepository);
      const save = tasks.saveReplyIfAbsent.bind(tasks);
      const lost = vi.spyOn(tasks, "saveReplyIfAbsent").mockRejectedValueOnce(LOST);
      await rpc(url, "SendMessage", approve("m-2", task.id));
      spy.mockRestore();
      lost.mockImplementation(save);

      const resent = await rpc(url, "SendMessage", approve("m-2", task.id));

      expect(resent.body.error).toBeUndefined();
      expect(taskOf(resent).status.state).toBe("TASK_STATE_CANCELED");
      expect(seen.charges).toEqual([]);
    });
  });
}
