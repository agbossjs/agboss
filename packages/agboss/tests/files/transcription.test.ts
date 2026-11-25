/**
 * #899 §6, §7: the transcription view — the built-in on the agent's vision model (scripted as
 * `mockModel(FileTranscriber)`), a project's own, a text format that needs none — cached once per file
 * across the calls of a visit and the visits of an execution, billed under `files:transcriber`.
 */
import { describe, expect } from "vitest";
import { FileTranscriber, type TranscriptionResult } from "../../src/files/file-transcriber.js";
import { FileSource, FileView, ModelFiles } from "../../src/files/model-files.js";
import { Injectable } from "../../src/index.js";
import { usd } from "../../src/units/index.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import { requestText } from "../pii/boundary.helpers.js";
import {
  CSV_BYTES,
  FETCHABLE,
  FetchTool,
  inline,
  PDF_BYTES,
  PNG_BYTES,
  readerApplication,
} from "./reader.factory.js";

const TRANSCRIBED = ModelFiles.of({ views: [FileView.Transcription] });
const builtIn = readerApplication({ files: TRANSCRIBED });
const withTools = readerApplication({
  files: ModelFiles.of({
    views: [FileView.Transcription],
    sources: [FileSource.Input, FileSource.ToolResults],
  }),
});

describe("AC5: the built-in transcriber runs on the agent's vision model", () => {
  testWith(builtIn.Application)(
    "AC5: the model reads the transcription, no bytes; it is billed under files:transcriber",
    async ({ app, mockModel }) => {
      const transcriber = mockModel(FileTranscriber).thenReturn(replyWith("TOTAL 12.50"));
      const agent = mockModel(builtIn.Agent).thenReturn(replyWith("ok"));

      const result = await execute(app, builtIn.Start, {
        document: inline(PNG_BYTES, "image/png", "receipt.png"),
      });

      expect(transcriber.requests).toHaveLength(1);
      const first = transcriber.onlyRequest;
      expect(first.kind === "chat" ? first.parts.map((part) => part.kind) : []).toEqual(["image"]);
      expect(agent.onlyRequest.kind === "chat" ? agent.onlyRequest.parts : []).toEqual([]);
      expect(requestText(agent.onlyRequest)).toContain(
        "receipt.png, image/png, 16 B, transcription)\nTOTAL 12.50",
      );
      expect(Object.keys(result.spend.byCaller)).toContain("files:transcriber");
      expect(result.spend.byCategory.files).toBeGreaterThanOrEqual(0);
    },
  );

  testWith(withTools.Application)(
    "AC5: one transcription of a file seen twice in the execution, cached by file hash",
    async ({ app, mockModel }) => {
      const transcriber = mockModel(FileTranscriber).thenReturn(replyWith("TEXT"));
      FETCHABLE.set("q", inline(PNG_BYTES, "image/png", "same.png"));
      mockModel(withTools.Agent).thenReturn(callTool(FetchTool, { name: "q" }), replyWith("ok"));

      await execute(app, withTools.Start, {
        document: inline(PNG_BYTES, "image/png", "receipt.png"),
      });

      expect(transcriber.requests).toHaveLength(1);
    },
  );

  testWith(builtIn.Application)(
    "a text format is its own transcription: no model call",
    async ({ app, mockModel }) => {
      const transcriber = mockModel(FileTranscriber);
      const agent = mockModel(builtIn.Agent).thenReturn(replyWith("ok"));

      await execute(app, builtIn.Start, { document: inline(CSV_BYTES, "text/csv", "items.csv") });

      expect(transcriber.requests).toHaveLength(0);
      expect(requestText(agent.onlyRequest)).toContain("item,price\nlamp,12");
    },
  );
});

/** A project's own transcriber: a fixed text and a fixed price, no model. */
@Injectable()
class OcrTranscriber extends FileTranscriber {
  static calls = 0;

  transcribe(): Promise<TranscriptionResult> {
    OcrTranscriber.calls += 1;
    return Promise.resolve({ text: "OCR TEXT", cost: usd(0.01) });
  }
}

describe("AC5: a project replaces the transcriber (no model call)", () => {
  const own = readerApplication({ files: TRANSCRIBED, providers: [OcrTranscriber] });
  const ownApp = testWith(own.Application);
  ownApp(
    "AC5: the agent reads the project's text; its price is billed under files:transcriber as a tool cost",
    async ({ app, mockModel }) => {
      OcrTranscriber.calls = 0;
      const agent = mockModel(own.Agent).thenReturn(replyWith("ok"));

      const result = await execute(app, own.Start, {
        document: inline(PDF_BYTES, "application/pdf", "a.pdf"),
      });

      expect(OcrTranscriber.calls).toBe(1);
      expect(requestText(agent.onlyRequest)).toContain("OCR TEXT");
      expect(result.spend.byCaller["files:transcriber"]).toBeCloseTo(0.01);
      expect(
        result.spend.trace.find((line) => line.caller === "files:transcriber")?.costSource,
      ).toBe("tool");
    },
  );
});
