/**
 * #1316c review: the offload keys a file by the digest of its own bytes, never by a claimed one (a
 * caller claiming another file's digest could poison or overwrite it); a malformed digest or a wrong
 * size is refused before anything is saved. A tool's output refused for its files reaches the model as
 * a fixed text; any other error is never prompt text.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FileError } from "../../src/core/error-families/remote-errors.js";
import type { FileDto } from "../../src/dto/standard/file.js";
import { offloadedOutput } from "../../src/graph/agent-loop/call-output.js";
import { FileRefusal, FileUnavailableReason, fileRefused } from "../../src/files/file-errors.js";
import { offloadedInlineFiles } from "../../src/files/inline-cap.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { InMemoryFileRepository } from "../../src/infrastructure/in-memory-file.repository.js";

const bytes = Buffer.alloc(70 * 1024, "p");
const own = createHash("sha256").update(bytes).digest("hex");
const other = createHash("sha256").update("another file").digest("hex");

const file = (rest: Partial<FileDto> = {}): FileDto => ({
  mediaType: "text/plain",
  inline: bytes.toString("base64"),
  ...rest,
});

const offload = async (files: FileDto[]) => {
  const store = new InMemoryFileRepository(new InMemoryDatabase());
  const run = offloadedInlineFiles(files, {
    store,
    tenantId: "t",
    ownerId: "o",
    now: new Date(0),
  });
  return {
    store,
    failure: await run.then(
      () => undefined,
      (error: unknown) => error,
    ),
  };
};

describe("the offload's key is the bytes' own digest", () => {
  it("a claimed digest of another file is refused: nothing is saved under it", async () => {
    const claimed = file({ sha256: other });

    const { store, failure } = await offload([claimed]);

    expect(failure).toBeInstanceOf(FileError.Unavailable);
    expect(failure).toMatchObject({ reason: FileUnavailableReason.DigestMismatch });
    expect(await store.findMetadata({ tenantId: "t", fileId: `o.${other}` })).toBeUndefined();
    expect(claimed.inline).toBeDefined();
  });

  it("a malformed digest (a path, upper case, short) is refused before it is used in a key", async () => {
    for (const sha256 of ["../../etc/passwd", own.toUpperCase(), own.slice(1), ""]) {
      const { failure } = await offload([file({ sha256 })]);
      expect(failure).toMatchObject({ reason: FileUnavailableReason.DigestMismatch });
    }
  });

  it("a wrong sizeBytes is refused", async () => {
    const { failure } = await offload([file({ sha256: own, sizeBytes: 5 })]);
    expect(failure).toMatchObject({ reason: FileUnavailableReason.DigestMismatch });
  });

  it("one bad file among good ones: none is saved", async () => {
    const { store, failure } = await offload([file({ sha256: own }), file({ sha256: other })]);
    expect(failure).toBeDefined();
    expect(await store.findMetadata({ tenantId: "t", fileId: `o.${own}` })).toBeUndefined();
  });

  it("no digest: the computed one names the file and is written to the descriptor", async () => {
    const bare = file();

    const { store, failure } = await offload([bare]);

    expect(failure).toBeUndefined();
    expect(bare).toMatchObject({ fileId: `o.${own}`, sha256: own, sizeBytes: bytes.byteLength });
    expect((await store.findMetadata({ tenantId: "t", fileId: `o.${own}` }))?.sha256).toBe(own);
  });
});

describe("what a tool's offload failure tells the model", () => {
  const okOutput = Promise.resolve({ kind: "ok", value: {} } as const);
  const failing = (error: unknown) => ({
    inlineFiles: () => Promise.reject(error instanceof Error ? error : new Error("x")),
  });

  it("InlineTooLarge is a fixed text, with no byte of the file", async () => {
    const out = await offloadedOutput(
      failing(fileRefused({ refusal: FileRefusal.InlineTooLarge, sizeBytes: 99 })),
      okOutput,
    );
    expect(out).toMatchObject({ kind: "error" });
    expect((out as { message: string }).message).toBe(
      "the output's inline files are over the cap and no file store is listed",
    );
  });

  it("any other error is rethrown: its text never reaches the model", async () => {
    const failure = await offloadedOutput(
      failing(new Error("s3 says: secret-bucket key sk_live_123")),
      okOutput,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("secret-bucket");
  });
});
