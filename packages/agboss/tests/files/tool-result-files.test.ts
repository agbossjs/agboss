/**
 * #899 §2 review: a tool result's files are checked against the visit's budgets and file limits before
 * any read or transcription, and what the loop stores of them holds references, never bytes — the
 * model still receives them.
 */
import { describe, expect } from "vitest";
import { ModelFileLimitError } from "../../src/files/file-errors.js";
import { FileSource, ModelFiles } from "../../src/files/model-files.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import { requestText } from "../pii/boundary.helpers.js";
import {
  CountingFileRepository,
  FETCHABLE,
  FetchTool,
  inline,
  PDF_BYTES,
  PNG_BYTES,
  readerApplication,
  sha256Of,
} from "./reader.factory.js";

const SOURCES = [FileSource.Input, FileSource.ToolResults];

describe("a tool result's files are refused before they are read", () => {
  const counted = readerApplication({
    files: ModelFiles.of({ sources: SOURCES, maxFiles: 1 }),
    providers: [CountingFileRepository],
  });
  testWith(counted.Application)(
    "over maxFiles, a stored file of a tool result is never read",
    async ({ app, mockModel }) => {
      CountingFileRepository.reads = 0;
      FETCHABLE.set("stored", {
        mediaType: "application/pdf",
        fileId: "t.1",
        sha256: sha256Of(PDF_BYTES),
        sizeBytes: PDF_BYTES.byteLength,
      });
      mockModel(counted.Agent).thenReturn(callTool(FetchTool, { name: "stored" }));

      const failure = await execute(app, counted.Start, {
        document: inline(PNG_BYTES, "image/png", "a.png"),
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ModelFileLimitError);
      expect(CountingFileRepository.reads).toBe(0);
    },
  );
});

describe("a tool result's files obey the visit's limits before any read", () => {
  const limited = readerApplication({ files: ModelFiles.of({ sources: SOURCES, maxFiles: 1 }) });
  testWith(limited.Application)(
    "a second file from a tool over maxFiles is refused before it is read; no second model call",
    async ({ app, mockModel }) => {
      FETCHABLE.set("one", inline(PDF_BYTES, "application/pdf", "one.pdf"));
      const agent = mockModel(limited.Agent).thenReturn(callTool(FetchTool, { name: "one" }));

      const failure = await execute(app, limited.Start, {
        document: inline(PNG_BYTES, "image/png", "a.png"),
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ModelFileLimitError);
      expect(failure).toMatchObject({ limit: "max-files", actual: 2, allowed: 1 });
      expect(agent.requests).toHaveLength(1);
    },
  );
});

describe("a tool result's files in the stored call and the trace", () => {
  const reader = readerApplication({ files: ModelFiles.of({ sources: SOURCES }) });
  testWith(reader.Application)(
    "the call stores digests, not bytes; the model receives the file",
    async ({ app, mockModel }) => {
      const bytes = Buffer.from("%PDF-1.4 SECRET-TOOL-BYTES");
      FETCHABLE.set("s", inline(bytes, "application/pdf", "s.pdf"));
      const agent = mockModel(reader.Agent).thenReturn(
        callTool(FetchTool, { name: "s" }),
        replyWith("ok"),
      );

      const result = await execute(
        app,
        reader.Start,
        { document: inline(PNG_BYTES, "image/png", "a.png") },
        { includeRecord: true },
      );

      const b64 = bytes.toString("base64");
      expect(JSON.stringify([result.record, result.toolCalls])).not.toContain(b64);
      const [, second] = agent.requests;
      expect(second?.kind === "chat" ? second.parts.map((part) => part.sha256) : []).toContain(
        sha256Of(bytes),
      );
      expect(requestText(second ?? agent.onlyRequest)).not.toContain(b64);
    },
  );
});
