/**
 * #808 (security review, defence in depth): should the admitted request and the one the handler
 * decoded ever differ — a decoder of ours and the SDK's disagreeing — the handler refuses it
 * (`-32602 a2a.request-mismatch`) and the task it decoded is never touched. Forced here by an
 * admission that names another task than the request.
 */
import { beforeEach, describe, expect, vi } from "vitest";
import { A2AOperation } from "../../../src/a2a/a2a-caller.js";
import { callTool, testWith } from "../../../src/testing/index.js";
import {
  Charge,
  Clerk,
  resetRecovery,
  seen,
} from "../../infrastructure/fixtures/recovery.workflow.js";
import { BearerCallerResolver, resetAsked } from "../fixtures/bearer-caller-resolver.js";
import { OrdersA2AExpose, OrdersApplication } from "../fixtures/task.application.js";
import { errorInfoOf, rpc, text, userMessage } from "./rpc.js";

/** The task id every follow-up is admitted for, whatever it names. */
const ADMITTED_FOR = "task-a";

vi.mock("../../../src/a2a/server/a2a-admitted.js", async (original) => {
  const actual = await original<typeof import("../../../src/a2a/server/a2a-admitted.js")>();
  return {
    ...actual,
    admittedRequestOf: (body: unknown) => {
      const decoded = actual.admittedRequestOf(body);
      return decoded === undefined ||
        decoded.taskId === "" ||
        decoded.operation !== A2AOperation.SendMessage
        ? decoded
        : { ...decoded, taskId: ADMITTED_FOR };
    },
  };
});

const test = testWith(OrdersApplication);
const listener = { expose: OrdersA2AExpose, callerResolver: BearerCallerResolver };

beforeEach(() => {
  resetRecovery();
  resetAsked();
});

describe("#808: a request the handler decodes otherwise than it was admitted", () => {
  test("a resume of task B admitted as one of task A: -32602, B never resumed", async ({
    a2aServer,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
    const { url } = await a2aServer(listener);
    const sent = await rpc(url, "SendMessage", { message: userMessage("m-1", [text("go")]) });
    const taskB = (sent.body.result as { task: { id: string } }).task.id;
    const approval = { data: { decision: { approved: true } }, mediaType: "application/json" };

    const answer = await rpc(url, "SendMessage", {
      message: userMessage("m-2", [approval], { taskId: taskB }),
    });
    const read = await rpc(url, "GetTask", { id: taskB });

    expect(errorInfoOf(answer)?.code).toBe("a2a.request-mismatch");
    expect(read.body.result).toMatchObject({ status: { state: "TASK_STATE_INPUT_REQUIRED" } });
    expect(seen.charges).toEqual([]);
  });
});
