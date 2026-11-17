/**
 * #1269 (mutation shard files-pii): `fileContentOf` — the size bound on any source, what a fetch's
 * failure is read as whatever it throws, a descriptor with no source, and what the content names.
 */
import { describe, expect, it } from "vitest";
import { A2AFileDto } from "../../src/a2a/files/a2a-file.dto.js";
import { fileContentOf, sha256Of, type FileReadContext } from "../../src/files/file-bytes.js";
import {
  ModelFileRefusal,
  ModelFileRefusedError,
  ModelFileUnavailableError,
  ModelFileUnavailableReason,
} from "../../src/files/file-errors.js";
import { InMemoryA2AFileRepository } from "../../src/infrastructure/in-memory-a2a-file.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { kilobytes, seconds } from "../../src/units/index.js";

const URL_OF = "https://files.example/a.txt";

const contextOn = (parts: Partial<FileReadContext> = {}): FileReadContext => ({
  store: new InMemoryA2AFileRepository(new InMemoryDatabase()),
  tenantId: "acme",
  ownerId: "root-1",
  signal: new AbortController().signal,
  clock: new VirtualClock(),
  transport: () => Promise.reject(new Error("no network")),
  allowedOrigins: ["https://files.example"],
  fetchTimeout: seconds(5),
  maxFileSize: kilobytes(1),
  ...parts,
});

const failureOf = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => undefined,
    (error: unknown) => error,
  );

const textOf = (size: number): Uint8Array => new Uint8Array(size).fill(0x61);
const inlineOf = (bytes: Uint8Array, rest: Partial<A2AFileDto> = {}): A2AFileDto => ({
  mediaType: "text/plain",
  inline: Buffer.from(bytes).toString("base64"),
  ...rest,
});

describe("the size bound holds for every source, at the byte", () => {
  it("an inline file of exactly maxFileSize is read; one byte more is refused (too-large)", async () => {
    const context = contextOn();

    const fits = await fileContentOf(inlineOf(textOf(1024)), context);
    const failure = await failureOf(fileContentOf(inlineOf(textOf(1025)), context));

    expect(fits.bytes.byteLength).toBe(1024);
    expect(failure).toBeInstanceOf(ModelFileRefusedError);
    expect(failure).toMatchObject({ refusal: ModelFileRefusal.TooLarge });
  });

  it("a stored file over maxFileSize is refused too, before its digest is looked at", async () => {
    const context = contextOn();
    const bytes = textOf(2048);
    await context.store.save({
      tenantId: "acme",
      fileId: "root-1.big",
      ownerId: "root-1",
      mediaType: "text/plain",
      sha256: sha256Of(bytes),
      sizeBytes: bytes.byteLength,
      createdAt: new Date(0),
      bytes,
    });

    const failure = await failureOf(
      fileContentOf(
        { mediaType: "text/plain", fileId: "root-1.big", sha256: "0".repeat(64) },
        context,
      ),
    );

    expect(failure).toMatchObject({ refusal: ModelFileRefusal.TooLarge });
  });
});

describe("what the content names", () => {
  it("a descriptor's filename is kept; without one the content has no filename key", async () => {
    const bytes = textOf(4);

    const named = await fileContentOf(inlineOf(bytes, { filename: "a.txt" }), contextOn());
    const anonymous = await fileContentOf(inlineOf(bytes), contextOn());

    expect(named.filename).toBe("a.txt");
    expect(Object.keys(anonymous).sort()).toEqual(["bytes", "mediaType", "sha256"]);
    expect(anonymous.sha256).toBe(sha256Of(bytes));
  });
});

describe("a descriptor with no source at all", () => {
  it("is neither stored nor found: a file stored under some odd id is not read for it", async () => {
    const context = contextOn();
    const bytes = textOf(4);
    await context.store.save({
      tenantId: "acme",
      fileId: "Stryker was here!",
      ownerId: "root-1",
      mediaType: "text/plain",
      sha256: sha256Of(bytes),
      sizeBytes: bytes.byteLength,
      createdAt: new Date(0),
      bytes,
    });

    const failure = await failureOf(fileContentOf({ mediaType: "text/plain" }, context));

    expect(failure).toBeInstanceOf(ModelFileRefusedError);
    expect(failure).toMatchObject({ refusal: ModelFileRefusal.UrlInvalid });
  });

  it("a stored descriptor without an id (none is a stored file's) finds nothing", async () => {
    const context = contextOn();

    const failure = await failureOf(
      fileContentOf({ mediaType: "text/plain", fileId: "" }, context),
    );

    expect(failure).toMatchObject({ reason: ModelFileUnavailableReason.NotFound });
  });
});

/** A clock whose sleep throws `thrown`: the fetch fails with that, as no refusal of its own. */
const failingWith = (thrown: unknown): FileReadContext =>
  contextOn({
    clock: {
      now: () => new Date(0),
      sleep: () => {
        throw thrown;
      },
    },
  });

describe("a fetch that fails some way of its own is unavailable (download-failed)", () => {
  const download = { mediaType: "text/plain", url: URL_OF };

  it.each([
    ["a string", "boom"],
    ["a number", 5],
    ["null", null],
    ["an object without metadata", {}],
    ["an error whose metadata is null", { metadata: null }],
    ["an error whose metadata is a string", { metadata: "code" }],
    ["an error whose metadata is undefined", { metadata: undefined }],
    ["an error whose metadata has no code", { metadata: {} }],
    ["an error whose code is no string", { metadata: { code: 5 } }],
    ["an error whose code is a string of another kind", { metadata: { code: "a2a.other" } }],
  ])("%s", async (_name, thrown) => {
    const failure = await failureOf(fileContentOf(download, failingWith(thrown)));

    expect(failure).toBeInstanceOf(ModelFileUnavailableError);
    expect(failure).toMatchObject({ reason: ModelFileUnavailableReason.DownloadFailed });
    expect(failure).toHaveProperty("cause", thrown);
  });

  it("a code is read as a string only: an array that prints as a refusal's is none", async () => {
    const failure = await failureOf(
      fileContentOf(download, failingWith({ metadata: { code: ["a2a.file-too-large"] } })),
    );

    expect(failure).toBeInstanceOf(ModelFileUnavailableError);
  });

  it.each([
    ["a2a.file-origin-denied", ModelFileRefusal.OriginDenied],
    ["a2a.file-url-not-allowed", ModelFileRefusal.OriginDenied],
    ["a2a.file-address-denied", ModelFileRefusal.AddressDenied],
    ["a2a.file-url-invalid", ModelFileRefusal.UrlInvalid],
    ["a2a.file-too-large", ModelFileRefusal.TooLarge],
  ])("the code %s is the refusal %s", async (code, refusal) => {
    const thrown = { metadata: { code } };

    const failure = await failureOf(fileContentOf(download, failingWith(thrown)));

    expect(failure).toBeInstanceOf(ModelFileRefusedError);
    expect(failure).toMatchObject({ refusal, cause: thrown });
  });
});
