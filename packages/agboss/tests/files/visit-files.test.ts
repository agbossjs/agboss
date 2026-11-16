/** #899 §3: a later read of files already pinned is held to their digests. */
import { describe, expect, it } from "vitest";
import { ModelFileUnavailableReason } from "../../src/files/file-errors.js";
import { resolvedFilesOf } from "../../src/files/file-settings.js";
import { NO_FILES, filePiecesOf, type FileRuntime } from "../../src/files/visit-files.js";
import { InMemoryA2AFileRepository } from "../../src/infrastructure/in-memory-a2a-file.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { kilobytes, megabytes, seconds } from "../../src/units/index.js";
import { ModelFiles } from "../../src/files/model-files.js";
import { inline, PDF_BYTES, sha256Of } from "./reader.factory.js";

const runtime: FileRuntime = {
  agent: "a-agent",
  settings: resolvedFilesOf({
    agent: ModelFiles.of({}).options,
    defaults: undefined,
    skills: [],
    a2aFiles: undefined,
    hasPiiPolicy: false,
  }),
  maxResultSize: kilobytes(8),
  transcriberKey: () => "t",
  transcribe: () => Promise.reject(new Error("no transcription")),
  context: () => ({
    store: new InMemoryA2AFileRepository(new InMemoryDatabase()),
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
      reason: ModelFileUnavailableReason.DigestMismatch,
    });
  });
});
