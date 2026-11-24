/** #899 §3: a later read of files already pinned is held to their digests. */
import { NO_REDACTION } from "./runtime-parts.js";
import { describe, expect, it } from "vitest";
import { FileRedactionFailedError, FileUnavailableReason } from "../../src/files/file-errors.js";
import { resolvedFilesOf } from "../../src/files/file-settings.js";
import { NO_FILES, filePiecesOf, type FileRuntime } from "../../src/files/visit-files.js";
import { InMemoryFileRepository } from "../../src/infrastructure/in-memory-file.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { kilobytes, megabytes, seconds } from "../../src/units/index.js";
import { FileView, ModelFiles } from "../../src/files/model-files.js";
import { inline, PDF_BYTES, sha256Of } from "./reader.factory.js";

const runtime: FileRuntime = {
  agent: "a-agent",
  settings: resolvedFilesOf({
    agent: ModelFiles.of({}).options,
    defaults: undefined,
    filePolicy: undefined,
    hasPiiPolicy: false,
  }),
  maxResultSize: kilobytes(8),
  ...NO_REDACTION,
  transcriberKey: () => "t",
  transcribe: () => Promise.reject(new Error("no transcription")),
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

const batch = (pins?: readonly string[]) => ({
  runtime,
  files: [{ descriptor: inline(PDF_BYTES, "application/pdf", "a.pdf"), field: "f", producer: "p" }],
  tally: NO_FILES,
  cache: {},
  first: 1,
  ...(pins === undefined ? {} : { pins }),
  beforeModelCall: () => undefined,
});

describe("pinned digests", () => {
  it("a read that matches its pins gives the pieces and names the digests", async () => {
    const built = await filePiecesOf(batch([sha256Of(PDF_BYTES)]));

    expect(built.digests).toEqual([sha256Of(PDF_BYTES)]);
    expect(built.pieces).toHaveLength(2);
  });

  it("a read whose bytes are not the pinned ones is digest-mismatch", async () => {
    await expect(filePiecesOf(batch(["0".repeat(64)]))).rejects.toMatchObject({
      reason: FileUnavailableReason.DigestMismatch,
    });
  });
});

describe("the redacted view of a type no redactor takes fails closed, before any call", () => {
  const redacting: FileRuntime = {
    ...runtime,
    settings: resolvedFilesOf({
      agent: ModelFiles.of({ views: [FileView.Redacted] }).options,
      defaults: undefined,
      filePolicy: undefined,
      hasPiiPolicy: false,
    }),
    redact: () => Promise.reject(new Error("must not be asked")),
  };
  const mask = {
    policyHash: "h",
    known: {},
    mask: (text: string) => Promise.resolve({ text, tokens: {}, usage: [] }),
    redaction: { kinds: [], values: [], blocked: [], isModelChecked: true },
    redactionDigestOf: () => "d",
    maskCacheKeyOf: () => "k",
    refusalForKind: () => Promise.resolve(undefined),
  };

  it("a PDF the redactor does not support is FileRedactionFailedError, never the original", async () => {
    const run = filePiecesOf({ ...batch(), runtime: redacting, mask });

    await expect(run).rejects.toBeInstanceOf(FileRedactionFailedError);
  });
});
