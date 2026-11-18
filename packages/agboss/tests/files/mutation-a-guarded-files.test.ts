/** #1269: the files a guardrail checks, and what masking their headings and names costs. */
import { describe, expect, it } from "vitest";
import type { UsageRecord } from "../../src/finops/usage.js";
import { CostSource } from "../../src/finops/cost-source.js";
import type { FileContent } from "../../src/files/file-bytes.js";
import type { FileMask } from "../../src/files/file-mask.js";
import { guardedFilesOf } from "../../src/files/guarded-files.js";
import type { ViewedFile } from "../../src/files/visit-files.js";
import { kilobytes } from "../../src/units/index.js";

const usageOf = (caller: string): UsageRecord => ({
  caller,
  model: "m",
  costUsd: 0,
  costSource: CostSource.Tool,
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

/** A mask that wraps a text in brackets, spends one record named by the text, and keeps its calls. */
function recordingMask(): { readonly mask: FileMask; readonly asked: unknown[] } {
  const asked: unknown[] = [];
  const known = { "<t>": "x" };
  const mask: FileMask = {
    policyHash: "p",
    known,
    redaction: { kinds: [], values: [], blocked: [], isModelChecked: false },
    redactionDigestOf: () => "d",
    maskCacheKeyOf: (text) => text,
    refusalForKind: () => Promise.resolve(undefined),
    mask: (text, tokens) => {
      asked.push([text, tokens === known]);
      return Promise.resolve({ text: `[${text}]`, tokens: {}, usage: [usageOf(text)] });
    },
  };
  return { mask, asked };
}

const content = (mediaType: string, filename?: string, body = "AAA"): FileContent => ({
  mediaType,
  bytes: new TextEncoder().encode(body),
  sha256: "s",
  ...(filename === undefined ? {} : { filename }),
});

const viewed = (file: FileContent, heading = "H"): ViewedFile => ({ content: file, heading });
const room = kilobytes(8);
const callers = (usage: readonly UsageRecord[]): string[] => usage.map((record) => record.caller);

describe("guardedFilesOf", () => {
  it("gives each file with the pieces it is sent as, and no spend, where nothing is masked", async () => {
    const pdf = content("application/pdf", "a.pdf");
    const text = content("text/plain", undefined, "hello");

    const guarded = await guardedFilesOf([viewed(pdf), viewed(text, "T")], room);

    expect(guarded.usage).toStrictEqual([]);
    expect(guarded.files).toStrictEqual([
      {
        content: pdf,
        pieces: [
          { kind: "text", text: "H" },
          { kind: "file", mediaType: "application/pdf", filename: "a.pdf", data: "QUFB" },
        ],
      },
      { content: text, pieces: [{ kind: "text", text: "T\nhello" }] },
    ]);
  });

  it("masks a heading and a file name, in the pieces and in the file, and counts what it cost", async () => {
    const { mask, asked } = recordingMask();
    const pdf = content("application/pdf", "a.pdf");

    const guarded = await guardedFilesOf([viewed(pdf)], room, mask);

    expect(guarded.files).toStrictEqual([
      {
        content: { ...pdf, filename: "[a.pdf]" },
        pieces: [
          { kind: "text", text: "[H]" },
          { kind: "file", mediaType: "application/pdf", filename: "[a.pdf]", data: "QUFB" },
        ],
      },
    ]);
    expect(asked).toStrictEqual([
      ["H", true],
      ["a.pdf", true],
      ["a.pdf", true],
    ]);
    expect(callers(guarded.usage)).toStrictEqual(["H", "a.pdf", "a.pdf"]);
  });

  it("masks a text format's text, the file with no name stays with none", async () => {
    const { mask, asked } = recordingMask();
    const text = content("text/plain", undefined, "hello");

    const guarded = await guardedFilesOf([viewed(text, "T")], room, mask);

    expect(guarded.files).toStrictEqual([
      { content: text, pieces: [{ kind: "text", text: "[T\nhello]" }] },
    ]);
    expect(asked).toStrictEqual([["T\nhello", true]]);
    expect(callers(guarded.usage)).toStrictEqual(["T\nhello"]);
  });

  it("asks nothing for a part that has no name, an image or a PDF alike", async () => {
    const { mask, asked } = recordingMask();
    const image = content("image/png");
    const pdf = content("application/pdf");

    const guarded = await guardedFilesOf([viewed(image), viewed(pdf, "P")], room, mask);

    expect(guarded.files).toStrictEqual([
      {
        content: image,
        pieces: [
          { kind: "text", text: "[H]" },
          { kind: "image", mediaType: "image/png", data: "QUFB" },
        ],
      },
      {
        content: pdf,
        pieces: [
          { kind: "text", text: "[P]" },
          { kind: "file", mediaType: "application/pdf", data: "QUFB" },
        ],
      },
    ]);
    expect(asked).toStrictEqual([
      ["H", true],
      ["P", true],
    ]);
    expect(callers(guarded.usage)).toStrictEqual(["H", "P"]);
  });

  it("keeps the order of the files and of their spend", async () => {
    const { mask } = recordingMask();

    const guarded = await guardedFilesOf(
      [viewed(content("application/pdf", "a.pdf"), "1"), viewed(content("audio/mpeg", "b"), "2")],
      room,
      mask,
    );

    expect(callers(guarded.usage)).toStrictEqual(["1", "a.pdf", "a.pdf", "2", "b"]);
  });
});
