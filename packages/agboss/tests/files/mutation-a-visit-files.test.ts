import { usd } from "../../src/units/index.js";
/** #1269: what a visit's files become — limits at their edges, removed files, masked transcriptions. */
import { describe, expect, it } from "vitest";
import { CostSource } from "../../src/finops/cost-source.js";
import type { UsageRecord } from "../../src/finops/usage.js";
import { ModelFileLimitError } from "../../src/files/file-errors.js";
import type { FileMask } from "../../src/files/file-mask.js";
import { resolvedFilesOf } from "../../src/files/file-settings.js";
import {
  NO_FILES,
  filePiecesOf,
  type FileBatch,
  type FileRuntime,
  type SourceFile,
} from "../../src/files/visit-files.js";
import { InMemoryFileRepository } from "../../src/infrastructure/in-memory-file.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { kilobytes, megabytes, seconds } from "../../src/units/index.js";
import { FileView, ModelFiles } from "../../src/files/model-files.js";
import { PDF_BYTES, inline, sha256Of } from "./reader.factory.js";
import { NO_REDACTION } from "./runtime-parts.js";

const baseSettings = resolvedFilesOf({
  agent: ModelFiles.of({}).options,
  defaults: undefined,
  skills: [],
  a2aFiles: undefined,
  hasPiiPolicy: false,
});

const usageOf = (caller: string): UsageRecord => ({
  caller,
  model: "m",
  costUsd: usd(0),
  costSource: CostSource.Tool,
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

function runtimeOf(over: Partial<typeof baseSettings> = {}): FileRuntime {
  return {
    agent: "a-agent",
    settings: { ...baseSettings, ...over },
    maxResultSize: kilobytes(8),
    ...NO_REDACTION,
    transcriberKey: () => "t",
    transcribe: (file) => Promise.resolve({ text: `read ${String(file.bytes.byteLength)}` }),
    context: () => ({
      store: new InMemoryFileRepository(new InMemoryDatabase()),
      tenantId: "t",
      ownerId: "o",
      signal: new AbortController().signal,
      clock: new VirtualClock(),
      transport: () => Promise.reject(new Error("no network")),
      allowedOrigins: [],
      fetchTimeout: seconds(1),
      maxFileSize: megabytes(1),
    }),
  };
}

const source = (bytes: Buffer, mediaType: string, name: string): SourceFile => ({
  descriptor: inline(bytes, mediaType, name),
  field: "f",
  producer: "p",
});

const batchOf = (
  runtime: FileRuntime,
  files: readonly SourceFile[],
  over?: Partial<FileBatch>,
) => ({
  runtime,
  files,
  tally: NO_FILES,
  cache: {},
  first: 1,
  beforeModelCall: () => undefined,
  ...over,
});

async function limitOf(run: Promise<unknown>): Promise<ModelFileLimitError> {
  const error = await run.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof ModelFileLimitError)) throw new Error("no limit error");
  return error;
}

describe("a file's declared type and size against the limits", () => {
  const TEXT = Buffer.from("0123456789");

  it("names every type the agent allows, in order, when a type is not one of them", async () => {
    const runtime = runtimeOf({ allowedMediaTypes: ["image/png", "application/pdf"] });

    const error = await limitOf(
      filePiecesOf(batchOf(runtime, [source(TEXT, "text/csv", "a.csv")])),
    );

    expect(error).toMatchObject({
      limit: "media-type",
      actual: "text/csv",
      allowed: "image/png, application/pdf",
    });
  });

  it("takes a file of exactly the largest size and refuses one byte more", async () => {
    const runtime = runtimeOf({ maxFileSize: 10, allowedMediaTypes: ["text/plain"] });

    const built = await filePiecesOf(batchOf(runtime, [source(TEXT, "text/plain", "a.txt")]));
    const error = await limitOf(
      filePiecesOf(batchOf(runtime, [source(Buffer.from("0123456789A"), "text/plain", "b.txt")])),
    );

    expect(built.digests).toEqual([sha256Of(TEXT)]);
    expect(error).toMatchObject({ limit: "max-file-size", actual: 11, allowed: 10 });
  });

  it("reads a file that declares no size", async () => {
    const runtime = runtimeOf({ maxFileSize: 10, allowedMediaTypes: ["text/plain"] });
    const { sizeBytes: _size, ...open } = inline(TEXT, "text/plain", "a.txt");

    const built = await filePiecesOf(
      batchOf(runtime, [{ descriptor: open, field: "f", producer: "p" }]),
    );

    expect(built.digests).toEqual([sha256Of(TEXT)]);
  });
});

describe("the total size of all views", () => {
  const TEXT = Buffer.from("0123456789");

  it("takes a total of exactly the limit and refuses one byte over, saying both", async () => {
    const files = [source(TEXT, "text/plain", "a.txt")];
    const total = (await filePiecesOf(batchOf(runtimeOf(), files))).tally.bytes;

    const exact = await filePiecesOf(batchOf(runtimeOf({ maxTotalFileSize: total }), files));
    const error = await limitOf(
      filePiecesOf(batchOf(runtimeOf({ maxTotalFileSize: total - 1 }), files)),
    );

    expect(exact.tally.bytes).toBe(total);
    expect(error).toMatchObject({
      limit: "max-total-file-size",
      actual: total,
      allowed: total - 1,
    });
  });
});

describe("a history file that retention removed", () => {
  const removed = (descriptor: SourceFile["descriptor"]): SourceFile => ({
    descriptor,
    field: "doc",
    producer: "start",
    isRemoved: true,
  });
  const png = "image/png";

  it("shows its name, else its id, else its url, else 'file', under its heading", async () => {
    const files = [
      removed({ mediaType: png, filename: "a.png", fileId: "f1", url: "https://x.example/u" }),
      removed({ mediaType: png, fileId: "f2", url: "https://x.example/u" }),
      removed({ mediaType: png, url: "https://x.example/u" }),
      removed({ mediaType: png }),
    ];

    const built = await filePiecesOf(batchOf(runtimeOf(), files, { first: 3, of: 9 }));

    expect(built.pieces.map((piece) => (piece.kind === "text" ? piece.text : ""))).toEqual([
      "### doc (from start, file 3 of 9: a.png, image/png) (removed)",
      "### doc (from start, file 4 of 9: f2, image/png) (removed)",
      "### doc (from start, file 5 of 9: https://x.example/u, image/png) (removed)",
      "### doc (from start, file 6 of 9: file, image/png) (removed)",
    ]);
  });

  it("numbers by place alone where the visit's count is unknown, and holds no digest", async () => {
    const files = [removed({ mediaType: png, filename: "a.png" })];

    const built = await filePiecesOf(batchOf(runtimeOf(), files, { first: 4 }));

    expect(built.pieces).toStrictEqual([
      { kind: "text", text: "### doc (from start, file 4: a.png, image/png) (removed)" },
    ]);
    expect(built.digests).toEqual([""]);
    expect(built.viewed).toEqual([]);
    expect(built.tally).toEqual({ count: 1, bytes: 0 });
  });

  it("numbers a removed file after a kept one by its place, and keeps the digests in order", async () => {
    const kept = source(PDF_BYTES, "application/pdf", "a.pdf");
    const gone = removed({ mediaType: png, filename: "b.png" });

    const built = await filePiecesOf(batchOf(runtimeOf(), [kept, gone], { first: 2 }));

    expect(built.digests).toEqual([sha256Of(PDF_BYTES), ""]);
    expect(built.pieces.at(-1)).toStrictEqual({
      kind: "text",
      text: "### doc (from start, file 3: b.png, image/png) (removed)",
    });
  });
});

/** A mask that brackets a text, reports the tokens it was asked against, and adds one token. */
function recordingMask(): { readonly mask: FileMask; readonly asked: unknown[] } {
  const asked: unknown[] = [];
  const known = { "<k>": "known" };
  let count = 0;
  const mask: FileMask = {
    policyHash: "p",
    known,
    redaction: { kinds: [], values: [], blocked: [], isModelChecked: false },
    redactionDigestOf: () => "d",
    maskCacheKeyOf: (text) => text,
    refusalForKind: () => Promise.resolve(undefined),
    mask: (text, tokens) => {
      asked.push({ ...tokens });
      count += 1;
      return Promise.resolve({
        text: `[${text}]`,
        tokens: { [`<t${String(count)}>`]: `v${String(count)}` },
        usage: [usageOf(`mask${String(count)}`)],
      });
    },
  };
  return { mask, asked };
}

describe("masked transcriptions", () => {
  const settings = { views: [FileView.Transcription] };

  it("masks each against the tokens the policy knew and those the files before it made", async () => {
    const { mask, asked } = recordingMask();
    const files = [
      source(PDF_BYTES, "application/pdf", "a.pdf"),
      source(Buffer.from("%PDF-1.7 other"), "application/pdf", "b.pdf"),
    ];

    const built = await filePiecesOf(batchOf(runtimeOf(settings), files, { mask }));

    expect(asked).toEqual([{ "<k>": "known" }, { "<k>": "known", "<t1>": "v1" }]);
    expect(built.tokens).toEqual({ "<t1>": "v1", "<t2>": "v2" });
    expect(built.usage.map((record) => record.caller)).toEqual(["mask1", "mask2"]);
  });

  it("keeps the masked text under its key, and lists only the masked texts as masked", async () => {
    const { mask } = recordingMask();

    const built = await filePiecesOf(
      batchOf(runtimeOf(settings), [source(PDF_BYTES, "application/pdf", "a.pdf")], { mask }),
    );

    const key = `${sha256Of(PDF_BYTES)}:t:${String(baseSettings.transcriptionMaxTokens)}:p`;
    expect(built.transcripts).toEqual({ [key]: `[read ${String(PDF_BYTES.byteLength)}]` });
    expect(built.maskedTexts).toEqual([`[read ${String(PDF_BYTES.byteLength)}]`]);
    expect(built.pieces).toHaveLength(2);
  });

  it("does not list an unmasked text or a part among the masked ones", async () => {
    const { mask } = recordingMask();
    const runtime = runtimeOf({ views: [FileView.Original] });

    const built = await filePiecesOf(
      batchOf(runtime, [source(PDF_BYTES, "application/pdf", "a.pdf")], { mask }),
    );

    expect(built.pieces.map((piece) => piece.kind)).toEqual(["text", "file"]);
    expect(built.maskedTexts).toEqual([]);
    expect(built.transcripts).toEqual({});
  });

  it("keeps nothing for a transcription that came from the cache", async () => {
    const key = `${sha256Of(PDF_BYTES)}:t:${String(baseSettings.transcriptionMaxTokens)}:`;

    const built = await filePiecesOf(
      batchOf(runtimeOf(settings), [source(PDF_BYTES, "application/pdf", "a.pdf")], {
        cache: { [key]: "cached text" },
      }),
    );

    expect(built.transcripts).toEqual({});
    expect(built.pieces).toStrictEqual([
      {
        kind: "text",
        text: expect.stringContaining("cached text") as string,
      },
    ]);
  });
});
