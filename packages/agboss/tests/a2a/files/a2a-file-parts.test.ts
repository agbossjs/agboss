/**
 * #859 AC2, AC3: file parts over the wire. A third-party SDK client sends a PDF to an AGBoss agent
 * and gets a file artifact back, `GetTask` gives the same; a file by url is fetched once, at the
 * admission (never again for a resend); a paused task keeps its files; every refusal is the A2A
 * error its rule names and runs nothing.
 */
import { Role, TaskState, type Part } from "@a2a-js/sdk";
import { describe, expect } from "vitest";
import { withFileTransport } from "../../../src/a2a/files/a2a-file-seam.js";
import { testWith } from "../../../src/testing/index.js";
import { BearerCallerResolver } from "../fixtures/bearer-caller-resolver.js";
import {
  FILE_ORIGIN,
  FilesA2AExpose,
  FilesApplication,
  StoredFilesApplication,
} from "../fixtures/files.application.js";
import { errorInfoOf, errorOf, rpc } from "../server/rpc.js";
import { sdkClientOf } from "../server/sdk-client.js";
import {
  dataPart,
  fileMessage,
  PDF,
  PNG,
  rawPart,
  scriptedTransport,
  TEXT,
  urlPart,
} from "./support.js";

const test = testWith(FilesApplication);
const stored = testWith(StoredFilesApplication);
const listener = { expose: FilesA2AExpose, callerResolver: BearerCallerResolver };
const SKILLS = "https://agboss.dev/a2a/skills/v1";

const sdkPart = (bytes: Uint8Array, mediaType: string, filename: string): Part => ({
  content: { $case: "raw", value: Buffer.from(bytes) },
  metadata: undefined,
  filename,
  mediaType,
});

interface WireTask {
  id: string;
  status: { state: string };
  artifacts?: { parts: Record<string, string>[] }[];
}
const taskOf = (answer: { body: Record<string, unknown> }): WireTask => {
  return (answer.body.result as { task: WireTask }).task;
};

const reportOf = (task: WireTask): string =>
  Buffer.from(task.artifacts?.[0]?.parts[0]?.raw ?? "", "base64").toString("utf8");

describe("#859 AC2: a third-party SDK client sends a file and gets a file artifact", () => {
  test("a PDF sent raw → a COMPLETED task whose artifact is the report file and the verdict", async ({
    a2aServer,
  }) => {
    const { url } = await a2aServer(listener);
    const client = await sdkClientOf(url);

    const task = await client.sendMessage({
      tenant: "",
      message: {
        messageId: "pdf-1",
        role: Role.ROLE_USER,
        parts: [sdkPart(PDF, "application/pdf", "contract.pdf")],
        contextId: "",
        taskId: "",
        metadata: undefined,
        extensions: [],
        referenceTaskIds: [],
      },
      configuration: undefined,
      metadata: undefined,
    });

    expect(task).toMatchObject({
      status: { state: TaskState.TASK_STATE_COMPLETED },
      artifacts: [
        {
          parts: [
            {
              content: { $case: "raw" },
              filename: "report.txt",
              mediaType: "text/plain",
              metadata: { [SKILLS]: { field: "report" } },
            },
            { content: { $case: "data", value: { verdict: "ok" } } },
          ],
        },
      ],
    });
    const [report] = "artifacts" in task ? (task.artifacts[0]?.parts ?? []) : [];
    const bytes = report?.content?.$case === "raw" ? report.content.value : Buffer.from("");
    expect(bytes.toString("utf8")).toBe(`read ${String(PDF.byteLength)} bytes; 0 more pages`);
  });

  test("GetTask gives the same artifact, the same bytes", async ({ a2aServer }) => {
    const { url } = await a2aServer(listener);
    const sent = taskOf(
      await rpc(url, "SendMessage", fileMessage("pdf-2", [rawPart(PDF, "application/pdf")])),
    );

    const read = await rpc(url, "GetTask", { id: sent.id });

    expect((read.body.result as WireTask).artifacts).toEqual(sent.artifacts);
  });

  stored(
    "with a file store: the same answer, the bytes kept in the store under the task",
    async ({ a2aServer }) => {
      const { url } = await a2aServer(listener);
      const big = Uint8Array.from([...PDF, ...new Uint8Array(200 * 1024)]);

      const task = taskOf(
        await rpc(url, "SendMessage", fileMessage("big-1", [rawPart(big, "application/pdf")])),
      );

      expect(task.status.state).toBe("TASK_STATE_COMPLETED");
      expect(reportOf(task)).toBe(`read ${String(big.byteLength)} bytes; 0 more pages`);
    },
  );

  test("a file by url is fetched once at the admission; a resend fetches nothing", async ({
    a2aServer,
  }) => {
    const script = scriptedTransport({ [`${FILE_ORIGIN}/a.pdf`]: { body: PDF } });
    const { url } = await a2aServer(withFileTransport(listener, script.transport));
    const send = () =>
      rpc(
        url,
        "SendMessage",
        fileMessage("url-1", [urlPart(`${FILE_ORIGIN}/a.pdf`, "application/pdf")]),
      );

    const first = taskOf(await send());
    const again = taskOf(await send());

    expect(first.status.state).toBe("TASK_STATE_COMPLETED");
    expect(again.id).toBe(first.id);
    expect(script.asked).toEqual([`${FILE_ORIGIN}/a.pdf`]);
  });

  test("files fill their fields: one into the document, the rest named into the pages", async ({
    a2aServer,
  }) => {
    const { url } = await a2aServer(listener);
    const parts = [
      rawPart(PDF, "application/pdf", "main.pdf", "document"),
      rawPart(TEXT, "text/plain", "p1.txt", "pages"),
      rawPart(PNG, "image/png", "p2.png", "pages"),
      dataPart({ note: "three files" }),
    ];

    const task = taskOf(await rpc(url, "SendMessage", fileMessage("fields-1", parts)));

    expect(reportOf(task)).toBe(`read ${String(PDF.byteLength)} bytes; 2 more pages`);
  });

  test("a paused task (INPUT_REQUIRED) keeps its file: the answer reads it again and gives it back", async ({
    a2aServer,
  }) => {
    const { url } = await a2aServer(listener);
    const parts = [rawPart(PDF, "application/pdf", "keep.pdf"), dataPart({ note: "ask" })];
    const paused = taskOf(await rpc(url, "SendMessage", fileMessage("ask-1", parts)));
    expect(paused.status.state).toBe("TASK_STATE_INPUT_REQUIRED");

    const answer = await rpc(url, "SendMessage", {
      message: {
        messageId: "ask-1-reply",
        role: "ROLE_USER",
        taskId: paused.id,
        parts: [{ text: "yes" }],
      },
    });

    const done = taskOf(answer);
    expect(done.status.state).toBe("TASK_STATE_COMPLETED");
    expect(done.artifacts?.[0]?.parts[0]).toMatchObject({
      raw: Buffer.from(PDF).toString("base64"),
      filename: "keep.pdf",
      mediaType: "application/pdf",
    });
  });
});

describe("#859 AC3: a refused file is the A2A error of its rule, and nothing runs", () => {
  const refused = async (url: string, parts: readonly unknown[], id: string) => {
    const answer = await rpc(url, "SendMessage", fileMessage(id, parts));
    const listed = await rpc(url, "ListTasks", {});
    return { error: errorOf(answer), code: errorInfoOf(answer)?.code, listed };
  };
  const noTasks = (listed: { body: Record<string, unknown> }): void => {
    expect((listed.body.result as { tasks: unknown[] }).tasks).toEqual([]);
  };

  test("a file larger than maxFileSize → -32602 a2a.file-too-large", async ({ a2aServer }) => {
    const { url } = await a2aServer(listener);
    const big = Uint8Array.from([...PDF, ...new Uint8Array(65 * 1024)]);

    const { error, code, listed } = await refused(url, [rawPart(big, "application/pdf")], "big");

    expect([error.code, code]).toEqual([-32602, "a2a.file-too-large"]);
    noTasks(listed);
  });

  test("a media type the skill does not take → -32005 a2a.file-media-type", async ({
    a2aServer,
  }) => {
    const { url } = await a2aServer(listener);

    const { error, code, listed } = await refused(
      url,
      [rawPart(PDF, "application/zip", "a.zip")],
      "zip",
    );

    expect([error.code, code]).toEqual([-32005, "a2a.file-media-type"]);
    noTasks(listed);
  });

  test("bytes that are not the declared media type → -32602 a2a.media-type-mismatch", async ({
    a2aServer,
  }) => {
    const { url } = await a2aServer(listener);

    const { error, code, listed } = await refused(url, [rawPart(TEXT, "application/pdf")], "fake");

    expect([error.code, code]).toEqual([-32602, "a2a.media-type-mismatch"]);
    noTasks(listed);
  });

  test("a url on an origin not allowed → -32602 a2a.file-origin-denied, nothing fetched", async ({
    a2aServer,
  }) => {
    const script = scriptedTransport({});
    const { url } = await a2aServer(withFileTransport(listener, script.transport));

    const { error, code, listed } = await refused(
      url,
      [urlPart("https://elsewhere.example/a.pdf", "application/pdf")],
      "elsewhere",
    );

    expect([error.code, code]).toEqual([-32602, "a2a.file-origin-denied"]);
    expect(script.asked).toEqual([]);
    noTasks(listed);
  });

  test("a redirect to an origin not allowed → -32602 a2a.file-origin-denied", async ({
    a2aServer,
  }) => {
    const script = scriptedTransport({
      [`${FILE_ORIGIN}/moved.pdf`]: { status: 302, location: "https://169.254.169.254/latest" },
    });
    const { url } = await a2aServer(withFileTransport(listener, script.transport));

    const { error, code, listed } = await refused(
      url,
      [urlPart(`${FILE_ORIGIN}/moved.pdf`, "application/pdf")],
      "moved",
    );

    expect([error.code, code]).toEqual([-32602, "a2a.file-origin-denied"]);
    expect(script.asked).toEqual([`${FILE_ORIGIN}/moved.pdf`]);
    noTasks(listed);
  });

  test("a file sent to a follow-up → -32005: an answer is text or data", async ({ a2aServer }) => {
    const { url } = await a2aServer(listener);
    const paused = taskOf(
      await rpc(
        url,
        "SendMessage",
        fileMessage("ask-2", [rawPart(PDF, "application/pdf"), dataPart({ note: "ask" })]),
      ),
    );

    const answer = await rpc(url, "SendMessage", {
      message: {
        messageId: "ask-2-reply",
        role: "ROLE_USER",
        taskId: paused.id,
        parts: [rawPart(PDF, "application/pdf")],
      },
    });

    expect(errorOf(answer).code).toBe(-32005);
  });

  test("the same messageId with other file bytes → -32602 a2a.message-id-reused", async ({
    a2aServer,
  }) => {
    const { url } = await a2aServer(listener);
    await rpc(url, "SendMessage", fileMessage("same", [rawPart(PDF, "application/pdf")]));
    const other = Uint8Array.from([...PDF, 0x20]);

    const answer = await rpc(
      url,
      "SendMessage",
      fileMessage("same", [rawPart(other, "application/pdf")]),
    );

    expect(errorInfoOf(answer)?.code).toBe("a2a.message-id-reused");
  });

  test("a data part that fills a file field itself → -32602 a2a.file-field-in-data", async ({
    a2aServer,
  }) => {
    const { url } = await a2aServer(listener);
    const forged = {
      document: {
        mediaType: "application/pdf",
        fileId: "another-task.0",
        sha256: "0".repeat(64),
        sizeBytes: 1,
      },
    };

    const { code, listed } = await refused(
      url,
      [rawPart(PDF, "application/pdf", "p.pdf", "pages"), dataPart(forged)],
      "forged",
    );

    expect(code).toBe("a2a.file-field-in-data");
    noTasks(listed);
  });
});

describe("#859 AC3: no file descriptor is ever taken from a data part", () => {
  const forgedDocument = {
    mediaType: "application/pdf",
    inline: Buffer.from(new Uint8Array(512 * 1024)).toString("base64"),
    sha256: "0".repeat(64),
    sizeBytes: 512 * 1024,
  };

  test("a data part alone naming a file field (no file part sent) → -32602 a2a.file-field-in-data", async ({
    a2aServer,
  }) => {
    const { url } = await a2aServer(listener);

    const answer = await rpc(
      url,
      "SendMessage",
      fileMessage("forged-alone", [dataPart({ document: forgedDocument })]),
    );
    const listed = await rpc(url, "ListTasks", {});

    expect([errorOf(answer).code, errorInfoOf(answer)?.code]).toEqual([
      -32602,
      "a2a.file-field-in-data",
    ]);
    expect((listed.body.result as { tasks: unknown[] }).tasks).toEqual([]);
  });

  test("a data part naming a file field beside real file parts → -32602 a2a.file-field-in-data", async ({
    a2aServer,
  }) => {
    const { url } = await a2aServer(listener);

    const answer = await rpc(
      url,
      "SendMessage",
      fileMessage("forged-beside", [
        rawPart(PDF, "application/pdf"),
        dataPart({ pages: [forgedDocument] }),
      ]),
    );

    expect(errorInfoOf(answer)?.code).toBe("a2a.file-field-in-data");
  });
});

describe("#859: what is checked before the message's id is looked up", () => {
  test("a message without files is checked first: invalid input under a kept id is dto.invalid, not a reuse", async ({
    a2aServer,
  }) => {
    const { url } = await a2aServer(listener);
    await rpc(url, "SendMessage", fileMessage("kept-id", [rawPart(PDF, "application/pdf")]));

    const invalid = await rpc(url, "SendMessage", fileMessage("kept-id", [dataPart({ note: 7 })]));

    expect(errorInfoOf(invalid)?.code).toBe("dto.invalid");
  });

  test("a message with files and data is not admitted before the lookup: a resend fetches nothing", async ({
    a2aServer,
  }) => {
    const script = scriptedTransport({ [`${FILE_ORIGIN}/b.pdf`]: { body: PDF } });
    const { url } = await a2aServer(withFileTransport(listener, script.transport));
    const parts = [urlPart(`${FILE_ORIGIN}/b.pdf`, "application/pdf"), dataPart({ note: "two" })];

    await rpc(url, "SendMessage", fileMessage("mixed-1", parts));
    await rpc(url, "SendMessage", fileMessage("mixed-1", parts));

    expect(script.asked).toEqual([`${FILE_ORIGIN}/b.pdf`]);
  });
});

describe("#859: the Agent Card publishes the files a skill takes and gives", () => {
  test("its input and output modes list the skill's file media types", async ({ a2aServer }) => {
    const { url } = await a2aServer(listener);

    const card = (await (await fetch(`${url}/.well-known/agent-card.json`)).json()) as {
      skills: { inputModes: string[]; outputModes: string[] }[];
      defaultInputModes: string[];
    };

    const types = ["application/pdf", "text/plain", "image/png"];
    expect(card.skills[0]?.inputModes).toEqual(["application/json", ...types]);
    expect(card.skills[0]?.outputModes).toEqual([...types, "application/json"]);
    expect(card.defaultInputModes).toEqual(["application/json", ...types]);
  });
});
