/**
 * #899 AC1, AC2: an agent with files receives an image, a PDF and a CSV from its input in its model
 * call — the image and the PDF as parts, the CSV as text — pinned for every call of its visit, over the
 * limits it is held to before any call.
 */
import { FileError } from "../../src/core/error-families/remote-errors.js";
import { describe, expect } from "vitest";
import { ModelFileLimitError, FileRefusal } from "../../src/files/file-errors.js";
import { kilobytes } from "../../src/units/index.js";
import { FileSource, FileView, ModelFileLimit, ModelFiles } from "../../src/files/model-files.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import { requestText } from "../pii/boundary.helpers.js";
import {
  CSV_BYTES,
  CountingFileRepository,
  FETCHABLE,
  FetchTool,
  inline,
  PDF_BYTES,
  PNG_BYTES,
  readerApplication,
  sha256Of,
} from "./reader.factory.js";

const bundle = () => ({
  document: inline(PNG_BYTES, "image/png", "receipt.png"),
  pages: [
    inline(PDF_BYTES, "application/pdf", "invoice.pdf"),
    inline(CSV_BYTES, "text/csv", "items.csv"),
  ],
});

const ENABLED = ModelFiles.of({ views: [FileView.Original] });

const reader = readerApplication({ files: ENABLED });
const test = testWith(reader.Application);

describe("AC1: image, PDF and CSV reach the model", () => {
  test("AC1: the image and the PDF as parts, the CSV as text, every file under its heading", async ({
    app,
    mockModel,
  }) => {
    const agent = mockModel(reader.Agent).thenReturn(replyWith("read"));

    await execute(app, reader.Start, bundle());

    const [request] = agent.requests;
    expect(request?.kind === "chat" ? request.parts : []).toEqual([
      expect.objectContaining({
        kind: "image",
        mediaType: "image/png",
        sizeBytes: PNG_BYTES.byteLength,
        sha256: sha256Of(PNG_BYTES),
      }),
      expect.objectContaining({
        kind: "file",
        mediaType: "application/pdf",
        filename: "invoice.pdf",
        sha256: sha256Of(PDF_BYTES),
      }),
    ]);
    const text = requestText(agent.onlyRequest);
    expect(text).toContain("### bundle.document (from");
    expect(text).toContain("file 1 of 3: receipt.png, image/png, 16 B, original)");
    expect(text).toContain("file 2 of 3: invoice.pdf, application/pdf");
    expect(text).toContain("file 3 of 3: items.csv, text/csv");
    expect(text).toContain("item,price\nlamp,12");
  });

  test("AC1: every model call of the visit carries the same pinned bytes", async ({
    app,
    mockModel,
  }) => {
    FETCHABLE.set("a", inline(Buffer.from("%PDF-1.4 tool-file"), "application/pdf", "t.pdf"));
    const agent = mockModel(reader.Agent).thenReturn(
      callTool(FetchTool, { name: "a" }),
      replyWith("read"),
    );

    await execute(app, reader.Start, bundle());

    expect(agent.requests).toHaveLength(2);
    const first = agent.requests.map((request) => (request.kind === "chat" ? request.parts : []));
    expect(first[1]?.slice(0, 2)).toEqual(first[0]);
  });
});

/** The error or one of its causes that is of a class. */
function inChain<T extends Error>(
  error: unknown,
  type: abstract new (...args: never[]) => T,
): T | undefined {
  for (let cause: unknown = error; cause instanceof Error; cause = cause.cause)
    if (cause instanceof type) return cause;
  return undefined;
}

const big = (bytes: Buffer, size: number): Buffer => Buffer.concat([bytes, Buffer.alloc(size)]);

describe("AC6: limits fail closed before any model call", () => {
  const cases = [
    {
      name: "three files with maxFiles 2",
      files: ModelFiles.of({ maxFiles: 2 }),
      input: bundle(),
      expected: { limit: ModelFileLimit.MaxFiles, actual: 3, allowed: 2 },
    },
    {
      name: "a file over maxFileSize",
      files: ModelFiles.of({ maxFileSize: kilobytes(1) }),
      input: { document: inline(big(PNG_BYTES, 2048), "image/png", "big.png") },
      expected: { limit: ModelFileLimit.MaxFileSize, allowed: 1024 },
    },
    {
      name: "all views of two files over maxTotalFileSize (two views count twice)",
      files: ModelFiles.of({
        maxFileSize: kilobytes(1),
        maxTotalFileSize: kilobytes(1),
        views: [FileView.Original, FileView.Transcription],
      }),
      input: {
        document: inline(big(Buffer.from("a,b\n"), 300), "text/csv", "a.csv"),
        pages: [inline(big(Buffer.from("c,d\n"), 300), "text/csv", "b.csv")],
      },
      expected: { limit: ModelFileLimit.MaxTotalFileSize, allowed: 1024 },
    },
    {
      name: "a type the developer did not allow",
      files: ModelFiles.of({ allowedMediaTypes: ["image/png"] }),
      input: { document: inline(PDF_BYTES, "application/pdf", "a.pdf") },
      expected: {
        limit: ModelFileLimit.MediaType,
        actual: "application/pdf",
        allowed: "image/png",
      },
    },
  ];
  for (const { name, files, input, expected } of cases) {
    const limited = readerApplication({ files });
    testWith(limited.Application)(
      `AC6: ${name} → ModelFileLimitError, no model call`,
      async ({ app, mockModel }) => {
        const agent = mockModel(limited.Agent);

        const failure = await execute(app, limited.Start, input).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(ModelFileLimitError);
        expect(failure).toMatchObject({
          code: "step.model-file-limit",
          agent: limited.Agent.name === "" ? undefined : expect.any(String),
          ...expected,
        });
        expect(agent.requests).toHaveLength(0);
      },
    );
  }

  testWith(reader.Application)(
    "AC6: a file that is not what it says is refused by the guarded path, before any call",
    async ({ app, mockModel }) => {
      const agent = mockModel(reader.Agent);

      const failure = await execute(app, reader.Start, {
        document: inline(PDF_BYTES, "image/png", "lie.png"),
      }).catch((error: unknown) => error);

      expect(inChain(failure, FileError.Refused)).toMatchObject({
        refusal: FileRefusal.MediaTypeMismatch,
      });
      expect(agent.requests).toHaveLength(0);
    },
  );
});

describe("AC1: sources — input, tool results", () => {
  const withTools = readerApplication({
    files: ModelFiles.of({ sources: [FileSource.Input, FileSource.ToolResults] }),
  });
  const inputOnly = readerApplication({ files: ModelFiles.of({ sources: [FileSource.Input] }) });
  const toolFile = inline(Buffer.from("%PDF-1.4 from-tool"), "application/pdf", "tool.pdf");

  testWith(withTools.Application)(
    "AC1: a tool result's file follows the tool message as a user message with its part",
    async ({ app, mockModel }) => {
      FETCHABLE.set("scan", toolFile);
      const agent = mockModel(withTools.Agent).thenReturn(
        callTool(FetchTool, { name: "scan" }),
        replyWith("ok"),
      );

      await execute(app, withTools.Start, { document: bundle().document });

      const [, second] = agent.requests;
      const lines = second?.kind === "chat" ? second.messages : [];
      expect(lines.map((line) => line.role)).toEqual(["system", "human", "ai", "tool", "human"]);
      expect(second?.kind === "chat" ? second.parts.map((part) => part.sha256) : []).toEqual([
        sha256Of(PNG_BYTES),
        sha256Of(Buffer.from("%PDF-1.4 from-tool")),
      ]);
      // the tool message stays text: the descriptor, never the bytes
      expect(requestText(second ?? agent.onlyRequest)).not.toContain(toolFile.inline);
    },
  );

  testWith(inputOnly.Application)(
    "AC1: without FileSource.ToolResults a tool's file stays a description",
    async ({ app, mockModel }) => {
      FETCHABLE.set("scan", toolFile);
      const agent = mockModel(inputOnly.Agent).thenReturn(
        callTool(FetchTool, { name: "scan" }),
        replyWith("ok"),
      );

      await execute(app, inputOnly.Start, { document: bundle().document });

      const [, second] = agent.requests;
      expect(second?.kind === "chat" ? second.parts : []).toHaveLength(1);
    },
  );
});

describe("AC1: pinned bytes — a visit reads each file once", () => {
  const counted = readerApplication({ files: ENABLED, providers: [CountingFileRepository] });

  testWith(counted.Application)(
    "AC1: two model calls of one visit read the stored file once",
    async ({ app, mockModel }) => {
      CountingFileRepository.reads = 0;
      FETCHABLE.set("x", inline(PDF_BYTES, "application/pdf", "x.pdf"));
      mockModel(counted.Agent).thenReturn(callTool(FetchTool, { name: "x" }), replyWith("ok"));

      await execute(app, counted.Start, {
        document: {
          mediaType: "application/pdf",
          fileId: `stored-1.pdf`,
          sha256: sha256Of(PDF_BYTES),
          sizeBytes: PDF_BYTES.byteLength,
        },
      });

      expect(CountingFileRepository.reads).toBe(1);
    },
  );
});
