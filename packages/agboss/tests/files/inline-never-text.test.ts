/**
 * #899 §0: file bytes never leave as text — not into a prompt, a tool result, an event, a record,
 * a turn; with or without a PII runtime. Each place is checked for the base64 of a document's bytes.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { redactedFileOf } from "../../src/dto/standard/file.js";
import { redactedFilesIn, withoutInlineBytes } from "../../src/a2a/files/a2a-file-scrub.js";
import { unmasked } from "../../src/core/observer-manager.js";
import { closedResult } from "../../src/graph/agent-loop/tool-pii.js";
import { NO_OBSERVABILITY_MASK } from "../../src/pii/observability-mask.js";
import { maskedRecordOf } from "../../src/app/result.js";
import { schemaOf } from "../../src/dto/schema.js";
import { kilobytes } from "../../src/units/index.js";
import { finishLine, startLine } from "../../src/flow/runtime/history.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import { requestText } from "../pii/boundary.helpers.js";
import {
  DOCUMENT_BYTES,
  inlineFile,
  PrivateReaderApplication,
  ReaderApplication,
  ReaderAgent,
  ReaderStart,
  ScanResultDto,
  SCAN_BYTES,
  ScanTool,
  toldEvents,
} from "./files.fixture.js";

const DOCUMENT_B64 = DOCUMENT_BYTES.toString("base64");
const SCAN_B64 = SCAN_BYTES.toString("base64");

beforeEach(() => {
  toldEvents.length = 0;
});

const applications = [
  ["without a PII runtime", ReaderApplication],
  ["with a PII runtime", PrivateReaderApplication],
] as const;

for (const [label, application] of applications) {
  const test = testWith(application);

  describe(`AC2: inline never in any prompt, record, event or cassette (${label})`, () => {
    test("the model reads the descriptors, never the bytes", async ({ app, mockLlm }) => {
      const agent = mockLlm(ReaderAgent).thenReturn(
        callTool(ScanTool, { name: "a" }),
        replyWith("done"),
      );
      const document = await inlineFile(DOCUMENT_BYTES, "invoice.pdf");

      await execute(app, ReaderStart, { document, note: "hi" });

      const sent = agent.requests.map((request) => requestText(request)).join("\n");
      expect(sent).not.toContain(DOCUMENT_B64);
      expect(sent).not.toContain(SCAN_B64);
      expect(sent).toContain('"filename": "invoice.pdf"');
      expect(sent).toContain('"source": "inline"');
      expect(sent).toContain(
        `{"file":{"mediaType":"application/pdf","filename":"scan.pdf","sizeBytes":${String(SCAN_BYTES.byteLength)},"sha256":"${"b".repeat(64)}","source":"inline"}}`,
      );
    });

    test("records, tool calls and every observer event carry no bytes", async ({
      app,
      mockLlm,
    }) => {
      mockLlm(ReaderAgent).thenReturn(callTool(ScanTool, { name: "a" }), replyWith("done"));
      const document = await inlineFile(DOCUMENT_BYTES, "invoice.pdf");

      const result = await execute(app, ReaderStart, { document }, { record: true });

      const seen = JSON.stringify([result.record, result.toolCalls, toldEvents]);
      expect(seen).not.toContain(DOCUMENT_B64);
      expect(seen).not.toContain(SCAN_B64);
      expect(toldEvents.map((told) => told.hook)).toEqual(
        expect.arrayContaining(["router", "agent", "model", "tool", "tool-end"]),
      );
      expect(JSON.stringify(result.toolCalls)).toContain('"source":"inline"');
      // and the result's own masking step, with no mask at all
      const [first] = result.record?.scope ?? [];
      if (result.record === undefined || first === undefined) throw new Error("no record");
      const raw = {
        ...result,
        record: { ...result.record, scope: [{ ...first, value: document }] },
      };
      expect(JSON.stringify(raw)).toContain(DOCUMENT_B64);
      expect(JSON.stringify(await maskedRecordOf(raw, undefined))).not.toContain(DOCUMENT_B64);
    });
  });
}

describe("#899 §0: the scrub and the turn lines", () => {
  const file = {
    mediaType: "application/pdf",
    filename: "a.pdf",
    inline: "SEVMTE8=",
    sha256: "c".repeat(64),
    sizeBytes: 5,
  };

  it("redactedFileOf keeps what a file is, never what leads to its bytes", () => {
    expect(redactedFileOf(file)).toEqual({
      mediaType: "application/pdf",
      filename: "a.pdf",
      sizeBytes: 5,
      sha256: "c".repeat(64),
      source: "inline",
    });
    const stored = { mediaType: "text/csv", fileId: "t.0.abc", url: undefined };
    expect(JSON.stringify(redactedFilesIn({ deep: [{ stored }] }))).not.toContain("t.0.abc");
  });

  it("a turn keeps a file's whole descriptor but its bytes", () => {
    const stored = {
      mediaType: "text/csv",
      fileId: "t.0.abc",
      sha256: "d".repeat(64),
      sizeBytes: 1,
    };
    const line = startLine("s", { a: file, b: [stored] });
    expect(line).not.toContain("SEVMTE8=");
    expect(line).toContain("t.0.abc");
    expect(finishLine("f", { file })).not.toContain("SEVMTE8=");
    expect(withoutInlineBytes({ text: "inline stays a word", inline: "x" })).toEqual({
      text: "inline stays a word",
      inline: "x",
    });
  });
});

describe("#899 §0: every renderer scrubs on its own, whatever the layers around it", () => {
  const file = {
    mediaType: "application/pdf",
    inline: "U0VDUkVU",
    sha256: "c".repeat(64),
    sizeBytes: 6,
  };

  it("a tool result closed without a PII runtime shows the descriptor", async () => {
    const result = await closedResult(
      undefined,
      { output: schemaOf(ScanResultDto) },
      { kind: "ok", value: { file } },
      kilobytes(8),
    );

    expect(result.content).not.toContain("U0VDUkVU");
    expect(result.content).toContain('"source":"inline"');
  });

  it("an observer manager without a mask hands its observers no bytes", async () => {
    expect(JSON.stringify(await unmasked({ update: file }))).not.toContain("U0VDUkVU");
  });

  it("the no-policy observability mask shows trace text and values without bytes", async () => {
    const text = JSON.stringify({ input: file });

    expect(String(await NO_OBSERVABILITY_MASK.traceData(text))).not.toContain("U0VDUkVU");
    expect(JSON.stringify(await NO_OBSERVABILITY_MASK.value({ file }))).not.toContain("U0VDUkVU");
    expect(await NO_OBSERVABILITY_MASK.traceData("not json")).toBe("not json");
  });
});

describe("#899 §0: the scrub keeps what a value carries besides data", () => {
  it("a symbol-keyed brand on a plain record survives every walk", () => {
    const brand = Symbol("variant");
    const value = { [brand]: "ChangesRequestedDto", value: { notes: "n" } };

    const shown = redactedFilesIn({ update: value });
    const turn = withoutInlineBytes(value);

    expect(Reflect.get(Object(Reflect.get(Object(shown), "update")), brand)).toBe(
      "ChangesRequestedDto",
    );
    expect(Reflect.get(Object(turn), brand)).toBe("ChangesRequestedDto");
  });
});
