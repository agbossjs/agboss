/**
 * #900: a pause's decision never carries a file's descriptor — a follow-up `{ pauseId?, decision }`
 * holding an `A2AFileDto`-shaped object at any depth is `-32602 a2a.file-field-in-data`, nothing
 * resumed; a decision too deep or too large to read is refused too (`a2a.answer-shape`); one with
 * no descriptor resumes as before.
 */
import { describe, expect, it } from "vitest";
import { refuseFileDescriptorsIn } from "../../../src/a2a/server/a2a-forged-files.js";
import { testWith } from "../../../src/testing/index.js";
import { BearerCallerResolver } from "../fixtures/bearer-caller-resolver.js";
import { FilesA2AExpose, FilesApplication } from "../fixtures/files.application.js";
import { errorInfoOf, errorOf, rpc, type RpcAnswer } from "../server/rpc.js";
import { dataPart, fileMessage, PDF, rawPart } from "./support.js";

const test = testWith(FilesApplication);
const listener = { expose: FilesA2AExpose, callerResolver: BearerCallerResolver };

const FORGED = {
  mediaType: "application/pdf",
  fileId: "another-task.0",
  sha256: "a".repeat(64),
  sizeBytes: 9,
};

const codeOf = (run: () => void): string | undefined => {
  try {
    run();
    return undefined;
  } catch (error) {
    return (error as { metadata?: Record<string, string> }).metadata?.code ?? String(error);
  }
};

const nested = (depth: number): unknown => {
  let value: unknown = "leaf";
  for (let level = 0; level < depth; level += 1) value = [value];
  return value;
};

describe("#900: a decision's file descriptors", () => {
  it("a descriptor at the top, in a field, deep in a list — each refused; a mediaType alone is no file", () => {
    for (const source of ["fileId", "sha256", "inline", "url"])
      expect(
        codeOf(() => refuseFileDescriptorsIn({ mediaType: "text/plain", [source]: "x" })),
      ).toBe("a2a.file-field-in-data");
    expect(codeOf(() => refuseFileDescriptorsIn({ reply: "yes", attachment: FORGED }))).toBe(
      "a2a.file-field-in-data",
    );
    expect(codeOf(() => refuseFileDescriptorsIn({ a: [{ b: [[FORGED]] }] }))).toBe(
      "a2a.file-field-in-data",
    );
    expect(codeOf(() => refuseFileDescriptorsIn({ mediaType: "text/plain", reply: "yes" }))).toBe(
      undefined,
    );
    expect(codeOf(() => refuseFileDescriptorsIn(null))).toBeUndefined();
  });

  it("deeper than 64 levels or more than 10 000 values is refused: bounded, no stack to blow", () => {
    expect(codeOf(() => refuseFileDescriptorsIn(nested(64)))).toBeUndefined();
    expect(codeOf(() => refuseFileDescriptorsIn(nested(65)))).toBe("a2a.answer-shape");
    expect(codeOf(() => refuseFileDescriptorsIn(nested(100_000)))).toBe("a2a.answer-shape");
    expect(
      codeOf(() => refuseFileDescriptorsIn(Array.from({ length: 9_999 }, () => 1))),
    ).toBeUndefined();
    expect(codeOf(() => refuseFileDescriptorsIn(Array.from({ length: 10_000 }, () => 1)))).toBe(
      "a2a.answer-shape",
    );
  });
});

const taskOf = (answer: RpcAnswer): { id: string; status: { state: string } } => {
  const result = answer.body.result as { task?: { id: string; status: { state: string } } };
  if (result.task === undefined) throw new Error(`no task: ${JSON.stringify(answer.body)}`);
  return result.task;
};

describe("#900: a follow-up to a paused task", () => {
  test("a forged descriptor in its decision is -32602 a2a.file-field-in-data; the task still waits", async ({
    a2aServer,
  }) => {
    const { url } = await a2aServer(listener);
    const parts = [rawPart(PDF, "application/pdf", "keep.pdf"), dataPart({ note: "ask" })];
    const paused = taskOf(await rpc(url, "SendMessage", fileMessage("ask-1", parts)));

    const forged = await rpc(url, "SendMessage", {
      message: {
        messageId: "ask-1-reply",
        role: "ROLE_USER",
        taskId: paused.id,
        parts: [
          { data: { decision: { reply: "yes", pages: [FORGED] } }, mediaType: "application/json" },
        ],
      },
    });
    const read = await rpc(url, "GetTask", { id: paused.id });

    expect(errorOf(forged).code).toBe(-32602);
    expect(errorInfoOf(forged)?.code).toBe("a2a.file-field-in-data");
    expect(taskOf({ ...read, body: { result: { task: read.body.result } } }).status.state).toBe(
      "TASK_STATE_INPUT_REQUIRED",
    );
  });

  test("a decision with no descriptor resumes it", async ({ a2aServer }) => {
    const { url } = await a2aServer(listener);
    const parts = [rawPart(PDF, "application/pdf", "keep.pdf"), dataPart({ note: "ask" })];
    const paused = taskOf(await rpc(url, "SendMessage", fileMessage("ask-1", parts)));

    const answer = await rpc(url, "SendMessage", {
      message: {
        messageId: "ask-1-reply",
        role: "ROLE_USER",
        taskId: paused.id,
        parts: [{ data: { decision: { reply: "yes" } }, mediaType: "application/json" }],
      },
    });

    expect(taskOf(answer).status.state).toBe("TASK_STATE_COMPLETED");
  });
});
