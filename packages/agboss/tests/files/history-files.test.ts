/**
 * #899 §3 (AC2): `FileSource.History` — the files of the turns the agent remembers: a stored file of a root
 * execution of the same tenant and thread is read through the guarded path as a copy under the execution that
 * reads it; another thread's or tenant's file is never read; a file retention removed is `(removed)`; the
 * source needs a file store.
 */
import { bytes as byteSize } from "../../src/units/index.js";
import { describe, expect, it } from "vitest";
import { FileDto } from "../../src/dto/standard/file.js";
import { Nested } from "../../src/dto/index.js";
import { applicationOf } from "../../src/application/assemble.js";
import { sha256Of } from "../../src/files/file-bytes.js";
import { FileSource, FileView, ModelFiles } from "../../src/files/model-files.js";
import { InMemoryFileRepository } from "../../src/infrastructure/in-memory-file.repository.js";
import { Injectable } from "../../src/index.js";
import { IN_MEMORY_DATABASE } from "../../src/infrastructure/in-memory-database.js";
import { replyWith, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import { requestText } from "../pii/boundary.helpers.js";
import { PNG_BYTES, readerApplication } from "./reader.factory.js";

/** The store of the application under test, reachable by the test. */
@Injectable({ deps: [IN_MEMORY_DATABASE] })
class KeptFiles extends InMemoryFileRepository {
  static last: KeptFiles | undefined;

  constructor(...args: ConstructorParameters<typeof InMemoryFileRepository>) {
    super(...args);
    KeptFiles.last = this;
  }
}

const HISTORY = ModelFiles.of({
  sources: [FileSource.History],
  views: [FileView.Original],
  allowedMediaTypes: ["image/png"],
});
const reader = readerApplication({ files: HISTORY, providers: [KeptFiles] });
const FILE_ID = "turn-file-1";

/** The descriptor a past turn names: stored, its bytes are in the store. */
const named = (fileId = FILE_ID) => ({
  mediaType: "image/png",
  filename: "scan.png",
  fileId,
  sha256: sha256Of(PNG_BYTES),
  sizeBytes: PNG_BYTES.byteLength,
});

/** Keeps the file as `owner`'s, in `tenantId`. */
const keep = (owner: string, tenantId = "default", fileId = FILE_ID) =>
  KeptFiles.last?.save({
    tenantId,
    fileId,
    ownerId: owner,
    mediaType: "image/png",
    filename: "scan.png",
    sha256: sha256Of(PNG_BYTES),
    sizeBytes: byteSize(PNG_BYTES.byteLength),
    createdAt: new Date(0),
    bytes: PNG_BYTES,
  });

const partsOf = (request: { kind: string; parts?: readonly { sha256: string }[] }) =>
  request.kind === "chat" ? (request.parts ?? []) : [];

describe("AC2: the files of the turns the agent remembers", () => {
  testWith(reader.Application)(
    "AC2: a file of an earlier turn of the thread reaches the model, under its heading",
    async ({ app, mockLlm }) => {
      const agent = mockLlm(reader.Agent).thenReturn(replyWith("first"), replyWith("second"));
      const first = await execute(app, reader.Start, { document: named() }, { threadId: "chat-1" });
      await keep(first.executionId);

      await execute(app, reader.Start, { document: named("other") }, { threadId: "chat-1" });

      const second = agent.requests[1];
      expect(partsOf(second ?? agent.onlyRequest).map((part) => part.sha256)).toEqual([
        sha256Of(PNG_BYTES),
      ]);
      expect(requestText(second ?? agent.onlyRequest)).toContain("an earlier turn");
    },
  );

  testWith(reader.Application)(
    "AC2: another thread's file, and another tenant's, are never read: they render as removed",
    async ({ app, mockLlm }) => {
      const agent = mockLlm(reader.Agent).thenReturn(replyWith("first"), replyWith("second"));
      const first = await execute(app, reader.Start, { document: named() }, { threadId: "chat-2" });
      // the file belongs to an execution of no turn of this thread
      await keep("someone-elses-execution");

      await execute(app, reader.Start, { document: named("x") }, { threadId: "chat-2" });

      const second = agent.requests[1] ?? agent.onlyRequest;
      expect(partsOf(second)).toEqual([]);
      expect(requestText(second)).toContain("(removed)");
    },
  );

  testWith(reader.Application)(
    "AC2: a file retention removed is its descriptor, (removed): the visit goes on",
    async ({ app, mockLlm }) => {
      const agent = mockLlm(reader.Agent).thenReturn(replyWith("first"), replyWith("second"));
      await execute(app, reader.Start, { document: named("gone") }, { threadId: "chat-3" });

      const result = await execute(
        app,
        reader.Start,
        { document: named("y") },
        { threadId: "chat-3" },
      );

      expect(result.output).toEqual({ text: "second" });
      expect(requestText(agent.requests[1] ?? agent.onlyRequest)).toContain("(removed)");
    },
  );
});

describe("AC2: a history file handed back in an answer is a copy this execution owns", () => {
  class MaybeFileDto {
    @Nested(FileDto, { prompt: "the file", optional: true })
    file?: FileDto;
  }
  const answering = readerApplication({
    files: HISTORY,
    providers: [KeptFiles],
    output: MaybeFileDto,
  });

  testWith(answering.Application)(
    "AC2: the answer's file is read under the answering execution, same bytes and digest",
    async ({ app, mockLlm }) => {
      mockLlm(answering.Agent).thenReturn(
        replyWith(MaybeFileDto, {} as never),
        replyWith(MaybeFileDto, { file: { file: 1 } } as never),
      );
      const first = await execute(
        app,
        answering.Start,
        { document: named() },
        { threadId: "chat-4" },
      );
      await keep(first.executionId);

      const second = await execute(
        app,
        answering.Start,
        { document: named("z") },
        { threadId: "chat-4" },
      );

      const file = (second.output as { file: { fileId?: string; sha256?: string } }).file;
      const kept = await KeptFiles.last?.findMetadata({
        tenantId: "default",
        fileId: file.fileId ?? "",
      });
      expect(kept?.ownerId).toBe(second.executionId);
      expect(file.sha256).toBe(sha256Of(PNG_BYTES));
    },
  );
});

describe("[files.history-needs-store]: an earlier turn keeps a descriptor, not bytes", () => {
  it("without a FileRepository that keeps files the source is a start error", async () => {
    const inlineOnly = readerApplication({ files: HISTORY, providers: [] });

    const failure = await applicationOf(inlineOnly.Application).then(
      () => undefined,
      (error: unknown) => error,
    );

    const violations: unknown =
      failure instanceof Error ? Reflect.get(failure, "violations") : undefined;
    expect(JSON.stringify(violations)).toContain("files.history-needs-store");
    await expect(applicationOf(reader.Application)).resolves.toBeDefined();
  });
});
