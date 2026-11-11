/**
 * #859 AC2: an `A2AClient` sends and receives file parts — `A2AClientFile.fromBytes` / `.fromUrl`
 * in a typed input, an AGBoss agent's file artifact back into the output DTO, a foreign agent's
 * plain file parts (a task's artifact, a direct message) into `WorkflowFinishFileDto(s)`, a file by
 * url downloaded through the client's own fetch — and never a descriptor taken from a data part.
 */
import { AgentEvent } from "@a2a-js/sdk/server";
import type { Part } from "@a2a-js/sdk";
import { describe, expect, it } from "vitest";
import {
  A2AClient,
  A2AClientFile,
  A2AFileUnavailableError,
  A2AOriginError,
  A2ARemoteCallError,
  WorkflowFinishFileDto,
  WorkflowFinishFilesDto,
} from "../../../src/a2a/index.js";
import { WorkflowStartTextDto } from "../../../src/dto/index.js";
import { testWith } from "../../../src/testing/index.js";
import { kilobytes } from "../../../src/units/index.js";
import { BearerCallerResolver } from "../fixtures/bearer-caller-resolver.js";
import {
  FileSummaryA2AExpose,
  FilesApplication,
  ReviewRequestDto,
  ReviewResultDto,
} from "../fixtures/files.application.js";
import { fetchAs } from "../server/sdk-client.js";
import { PDF, TEXT } from "../files/support.js";
import {
  AGENT_URL,
  agentMessage,
  SdkAgent,
  taskOf,
  TaskState,
  urlOf,
} from "./support/sdk-agent.js";

const filePart = (content: Part["content"], filename = "out.txt"): Part => ({
  content,
  metadata: undefined,
  filename,
  mediaType: "text/plain",
});

/** A foreign agent whose task completes with these artifact parts. */
const completingWith = (parts: Part[]) =>
  new SdkAgent({
    script: async (context, bus) => {
      bus.publish(
        AgentEvent.task(taskOf(context, TaskState.TASK_STATE_COMPLETED, [{ name: "out", parts }])),
      );
      bus.finished();
    },
  });

const fileClientOf = <TOut extends object>(agent: SdkAgent, output: new () => TOut) =>
  new A2AClient<WorkflowStartTextDto, TOut>({
    url: AGENT_URL,
    fetcher: agent.fetcher,
    contract: { input: WorkflowStartTextDto, output },
  });

const test = testWith(FilesApplication);

describe("#859 AC2: an AGBoss agent, called with a file, answers with one", () => {
  test("execute sends fromBytes as a raw part of its field and reads the report back", async ({
    a2aServer,
  }) => {
    const { url } = await a2aServer({
      expose: FileSummaryA2AExpose,
      callerResolver: BearerCallerResolver,
    });
    const client = new A2AClient<ReviewRequestDto, ReviewResultDto>({
      url,
      fetcher: fetchAs("dana"),
      contract: { input: ReviewRequestDto, output: ReviewResultDto },
    });
    const document = A2AClientFile.fromBytes(PDF, {
      mediaType: "application/pdf",
      filename: "c.pdf",
    });

    const result = await client.execute({ document, note: "please" });
    const report = await client.downloadFile(result.report);

    expect(result).toMatchObject({
      verdict: "ok",
      report: { mediaType: "text/plain", filename: "report.txt" },
    });
    expect(new TextDecoder().decode(report)).toBe(`read ${String(PDF.byteLength)} bytes; please`);
  });
});

describe("#859 AC2: a foreign agent's file parts", () => {
  it("a task's raw part (no field named) → WorkflowFinishFileDto.file, its bytes inline", async () => {
    const agent = completingWith([filePart({ $case: "raw", value: Buffer.from(TEXT) })]);
    const client = fileClientOf(agent, WorkflowFinishFileDto);

    const { file } = await client.execute({ text: "go" });

    expect(file).toMatchObject({
      mediaType: "text/plain",
      filename: "out.txt",
      sizeBytes: TEXT.byteLength,
    });
    expect(Buffer.from(await client.downloadFile(file))).toEqual(Buffer.from(TEXT));
  });

  it("a direct message with two file parts → WorkflowFinishFilesDto.files, in order", async () => {
    const agent = new SdkAgent({
      script: async (context, bus) => {
        bus.publish(
          AgentEvent.message(
            agentMessage(context, [
              filePart({ $case: "raw", value: Buffer.from(TEXT) }, "a.txt"),
              filePart({ $case: "url", value: "https://files.example/b.txt" }, "b.txt"),
            ]),
          ),
        );
        bus.finished();
      },
    });

    const { files } = await fileClientOf(agent, WorkflowFinishFilesDto).execute({ text: "go" });

    expect(files.map((file) => [file.filename, file.url])).toEqual([
      ["a.txt", undefined],
      ["b.txt", "https://files.example/b.txt"],
    ]);
  });

  it("send gives the files of an untyped answer", async () => {
    const agent = completingWith([filePart({ $case: "url", value: "https://files.example/x" })]);

    const result = await fileClientOf(agent, WorkflowFinishFileDto).send("go");

    expect(result.files).toEqual([
      { mediaType: "text/plain", filename: "out.txt", url: "https://files.example/x" },
    ]);
  });

  it("an untyped answer of no file part gives no files", async () => {
    const agent = completingWith([
      {
        content: { $case: "text", value: "done" },
        metadata: undefined,
        filename: "",
        mediaType: "text/plain",
      },
    ]);

    const result = await fileClientOf(agent, WorkflowFinishFileDto).send("go");

    expect([result.text, result.files]).toEqual(["done", []]);
  });

  it("a data part that names a file field itself is no output: A2ARemoteCallError", async () => {
    const forged = {
      file: {
        mediaType: "text/plain",
        fileId: "caller-task.0",
        sha256: "0".repeat(64),
        sizeBytes: 1,
      },
    };
    const agent = completingWith([
      {
        content: { $case: "data", value: forged },
        metadata: undefined,
        filename: "",
        mediaType: "application/json",
      },
    ]);

    await expect(
      fileClientOf(agent, WorkflowFinishFileDto).execute({ text: "go" }),
    ).rejects.toBeInstanceOf(A2ARemoteCallError);
  });
});

describe("#859 AC3: a remote answer never gives a stored descriptor", () => {
  it("a part's metadata naming a fileId is no stored file: received files are inline or by url only", async () => {
    const part = filePart({ $case: "raw", value: Buffer.from(TEXT) });
    const agent = completingWith([
      {
        ...part,
        metadata: {
          fileId: "caller-task.0",
          "https://agboss.dev/a2a/skills/v1": { field: "file" },
        },
      },
    ]);

    const { file } = await fileClientOf(agent, WorkflowFinishFileDto).execute({ text: "go" });

    expect(file.fileId).toBeUndefined();
    expect(file.inline).toBe(Buffer.from(TEXT).toString("base64"));
  });
});

describe("#859: downloadFile", () => {
  const FILES = "https://files.example";
  const serving =
    (agent: SdkAgent, body: Uint8Array): typeof fetch =>
    (input, init) =>
      urlOf(input).startsWith(FILES)
        ? Promise.resolve(new Response(Buffer.from(body), { status: 200 }))
        : agent.fetcher(input, init);

  it("a file by url through the client's fetch, on its allowed origins, up to maxSize", async () => {
    const agent = completingWith([]);
    const client = new A2AClient({
      url: AGENT_URL,
      fetcher: serving(agent, TEXT),
      allowedOrigins: [FILES],
    });
    const file = A2AClientFile.fromUrl(`${FILES}/a.txt`, { mediaType: "text/plain" });

    const bytes = await client.downloadFile(file);
    const small = client.downloadFile(file, { maxSize: kilobytes(0) });

    expect(Buffer.from(bytes)).toEqual(Buffer.from(TEXT));
    await expect(small).rejects.toMatchObject({ reason: "too-large" });
  });

  it("a url on no allowed origin is refused before any request: A2AOriginError", async () => {
    const agent = completingWith([]);
    const client = new A2AClient({ url: AGENT_URL, fetcher: serving(agent, TEXT) });

    await expect(
      client.downloadFile(A2AClientFile.fromUrl(`${FILES}/a.txt`, { mediaType: "text/plain" })),
    ).rejects.toBeInstanceOf(A2AOriginError);
  });

  it("inline bytes that do not match their sha256: digest-mismatch", async () => {
    const client = new A2AClient({ url: AGENT_URL, fetcher: completingWith([]).fetcher });
    const file = Object.assign(A2AClientFile.fromBytes(TEXT, { mediaType: "text/plain" }), {
      sha256: "0".repeat(64),
    });

    await expect(client.downloadFile(file)).rejects.toBeInstanceOf(A2AFileUnavailableError);
  });
});
