/**
 * #1316: every path that turns a stored or inline file's bytes into content fails closed without a
 * digest (`FileUnavailableReason.DigestMissing`): the model-read path (agent parts, guardrail and
 * judge input, transcription and masking all read through it), `Files.read`, the A2A serving of an
 * output and a client's `downloadFile`. Only a file by url may come without one. A download with a
 * `timeout` and no clock still ends at the timeout.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { fileContentOf } from "../../src/files/file-bytes.js";
import { FileUnavailableReason } from "../../src/files/file-errors.js";
import { filePiecesOf, NO_FILES, type SourceFile } from "../../src/files/visit-files.js";
import { fileOutputPartsOf } from "../../src/a2a/server/a2a-output-parts.js";
import { downloadedFile } from "../../src/a2a/client/a2a-download.js";
import { InMemoryFileRepository } from "../../src/infrastructure/in-memory-file.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { bytes as byteSize, megabytes, seconds } from "../../src/units/index.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { resolvedFilesOf } from "../../src/files/file-settings.js";
import { FileView, ModelFiles } from "../../src/files/model-files.js";
import { NO_REDACTION } from "./runtime-parts.js";
import type { FileReadContext } from "../../src/files/file-bytes.js";
import type { FileDto } from "../../src/dto/standard/file.js";

const BYTES = Buffer.from("hello, digest");
const DIGEST = createHash("sha256").update(BYTES).digest("hex");
const store = new InMemoryFileRepository(new InMemoryDatabase());

const context = (): FileReadContext => ({
  store,
  tenantId: "t",
  ownerId: "o",
  signal: new AbortController().signal,
  clock: new VirtualClock(),
  transport: () => Promise.reject(new Error("no network")),
  allowedOrigins: [],
  fetchTimeout: seconds(1),
  maxFileSize: megabytes(1),
});

const reasonOf = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => "read",
    (error: unknown) => (error as { reason?: string }).reason ?? error,
  );

const inline = (sha256?: string): FileDto => ({
  mediaType: "text/plain",
  inline: BYTES.toString("base64"),
  ...(sha256 === undefined ? {} : { sha256 }),
});

const storedOf = async (withDigest: boolean): Promise<FileDto> => {
  await store.save({
    tenantId: "t",
    fileId: "kept",
    ownerId: "o",
    mediaType: "text/plain",
    sha256: DIGEST,
    sizeBytes: byteSize(BYTES.byteLength),
    createdAt: new Date(0),
    bytes: new Uint8Array(BYTES),
  });
  return { mediaType: "text/plain", fileId: "kept", ...(withDigest ? { sha256: DIGEST } : {}) };
};

describe("the model-read path needs a digest for a stored or inline file", () => {
  it("an inline file with none is refused before it is read, with one it is read", async () => {
    expect(await reasonOf(fileContentOf(inline(), context()))).toBe(
      FileUnavailableReason.DigestMissing,
    );
    expect((await fileContentOf(inline(DIGEST), context())).sha256).toBe(DIGEST);
  });

  it("a stored file with none is refused, with one it is read", async () => {
    expect(await reasonOf(fileContentOf(await storedOf(false), context()))).toBe(
      FileUnavailableReason.DigestMissing,
    );
    expect((await fileContentOf(await storedOf(true), context())).sha256).toBe(DIGEST);
  });

  it("a file by url may come without one (it is refused by the guarded fetch, not for the digest)", async () => {
    const reason = await reasonOf(
      fileContentOf({ mediaType: "text/plain", url: "https://x.example/a" }, context()),
    );
    expect(reason).not.toBe(FileUnavailableReason.DigestMissing);
  });
});

describe("what an agent's visit reads (model parts, guardrails, judges, transcription, masking)", () => {
  const batchOf = (descriptor: FileDto) => ({
    runtime: {
      agent: "a-agent",
      settings: resolvedFilesOf({
        agent: ModelFiles.of({ views: [FileView.Original] }).options,
        defaults: undefined,
        filePolicy: undefined,
        hasPiiPolicy: false,
      }),
      maxResultSize: megabytes(1),
      ...NO_REDACTION,
      transcriberKey: () => "t",
      transcribe: () => Promise.resolve({ text: "t" }),
      context,
    },
    files: [{ descriptor, field: "f", producer: "p" } satisfies SourceFile],
    tally: NO_FILES,
    cache: {},
    first: 1,
    beforeModelCall: () => undefined,
  });

  it("an inline file with no digest is refused, with one it is shown", async () => {
    expect(await reasonOf(filePiecesOf(batchOf(inline())))).toBe(
      FileUnavailableReason.DigestMissing,
    );
    expect((await filePiecesOf(batchOf(inline(DIGEST)))).digests).toEqual([DIGEST]);
  });
});

describe("serving an output over A2A", () => {
  const served = { fileFields: [{ name: "doc" }], hasData: false } as never;
  const outputOf = (file: FileDto) => ({ tenantId: "t", ownerId: "o", output: { doc: file } });
  const parts = (file: FileDto) =>
    fileOutputPartsOf(outputOf(file), served, store, () => {
      throw new Error("no data part");
    });

  it("an inline file with no digest, or a wrong one, is left out and counted missing", async () => {
    expect((await parts(inline())).missingFiles).toBe(1);
    expect((await parts(inline("0".repeat(64)))).missingFiles).toBe(1);
  });

  it("an inline file with its digest is served", async () => {
    const out = await parts(inline(DIGEST));
    expect(out.missingFiles).toBe(0);
    expect(out.parts).toHaveLength(1);
  });

  it("a stored file with no digest is left out", async () => {
    expect((await parts(await storedOf(false))).missingFiles).toBe(1);
    expect((await parts(await storedOf(true))).missingFiles).toBe(0);
  });
});

describe("a client's downloadFile", () => {
  const fetcher: typeof fetch = () => Promise.reject(new Error("no fetch"));

  it("an inline file with no digest is refused, with one it is handed out", async () => {
    expect(await reasonOf(downloadedFile(inline(), { fetcher }))).toBe(
      FileUnavailableReason.DigestMissing,
    );
    expect((await downloadedFile(inline(DIGEST), { fetcher })).byteLength).toBe(BYTES.byteLength);
  });

  it("a timeout with no clock still ends the download at the timeout", async () => {
    const slow: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });

    const reason = await reasonOf(
      downloadedFile(
        { mediaType: "text/plain", url: "https://x.example/a" },
        { fetcher: slow, timeout: 20 as never },
      ),
    );

    expect(reason).toBe(FileUnavailableReason.DownloadFailed);
  });
});
