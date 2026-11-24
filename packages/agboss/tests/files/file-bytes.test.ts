/**
 * #899 §3: the one guarded path that reads a file's bytes for a model — stored, inline or by url — its
 * refusals (origin, address, userinfo, size, media type, digest) and its read-once pinning.
 */
import { bytes as byteSize } from "../../src/units/index.js";
import { FileError } from "../../src/core/error-families/remote-errors.js";
import { describe, expect, it } from "vitest";
import { fileContentOf, sha256Of, type FileReadContext } from "../../src/files/file-bytes.js";
import { FileRefusal, FileUnavailableReason } from "../../src/files/file-errors.js";
import { InMemoryFileRepository } from "../../src/infrastructure/in-memory-file.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { httpsFileTransport } from "../../src/a2a/files/a2a-file-transport.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { kilobytes, seconds } from "../../src/units/index.js";
import { PDF, PNG, scriptedTransport, type ScriptedFile } from "../a2a/files/support.js";

const ORIGIN = "https://files.example";

const contextOn = (
  parts: Partial<FileReadContext> & {
    readonly files?: Readonly<Record<string, ScriptedFile>>;
  } = {},
): FileReadContext & { readonly asked: () => readonly string[] } => {
  const script = scriptedTransport(parts.files ?? {});
  return {
    store: new InMemoryFileRepository(new InMemoryDatabase()),
    tenantId: "acme",
    ownerId: "root-1",
    signal: new AbortController().signal,
    clock: new VirtualClock(),
    transport: script.transport,
    allowedOrigins: [ORIGIN],
    fetchTimeout: seconds(5),
    maxFileSize: kilobytes(1),
    ...parts,
    asked: () => script.asked,
  };
};

const described = (bytes: Uint8Array, mediaType: string) => ({
  mediaType,
  sha256: sha256Of(bytes),
  sizeBytes: byteSize(bytes.byteLength),
});

const failureOf = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => undefined,
    (error: unknown) => error,
  );

describe("AC1: reading a file's bytes for a model", () => {
  it("an inline file is decoded, its digest and media type checked, its sha256 named", async () => {
    const file = {
      ...described(PDF, "application/pdf"),
      inline: Buffer.from(PDF).toString("base64"),
    };

    const content = await fileContentOf(file, contextOn());

    expect(content).toMatchObject({ mediaType: "application/pdf", sha256: sha256Of(PDF) });
    expect([...content.bytes]).toEqual([...PDF]);
  });

  it("an inline file whose bytes are not its digest's is unavailable (digest-mismatch)", async () => {
    const file = {
      ...described(PDF, "application/pdf"),
      inline: Buffer.from(PNG).toString("base64"),
    };

    expect(await failureOf(fileContentOf(file, contextOn()))).toMatchObject({
      reason: FileUnavailableReason.DigestMismatch,
    });
  });

  it("a PDF that is a PNG, and a PNG that is a PDF, are refused (media-type-mismatch)", async () => {
    const asPdf = {
      ...described(PNG, "application/pdf"),
      inline: Buffer.from(PNG).toString("base64"),
    };
    const asPng = { ...described(PDF, "image/png"), inline: Buffer.from(PDF).toString("base64") };

    for (const file of [asPdf, asPng])
      expect(await failureOf(fileContentOf(file, contextOn()))).toMatchObject({
        refusal: FileRefusal.MediaTypeMismatch,
      });
  });

  it("a stored file is read for its task only: another owner's and another tenant's are not found", async () => {
    const context = contextOn();
    const saved = {
      tenantId: "acme",
      fileId: "root-1.abc",
      ownerId: "root-1",
      ...described(PDF, "application/pdf"),
      createdAt: new Date(0),
      bytes: PDF,
    };
    await context.store.save(saved);
    const file = { ...described(PDF, "application/pdf"), fileId: "root-1.abc" };

    expect((await fileContentOf(file, context)).sha256).toBe(sha256Of(PDF));
    expect(await failureOf(fileContentOf(file, { ...context, ownerId: "root-2" }))).toMatchObject({
      reason: FileUnavailableReason.NotFound,
    });
    expect(await failureOf(fileContentOf(file, { ...context, tenantId: "other" }))).toBeInstanceOf(
      FileError.Unavailable,
    );
  });
});

describe("AC6: a file by url goes through the guarded fetch", () => {
  const url = `${ORIGIN}/invoice.pdf`;

  it("an allowed origin is fetched once, its sha256 fixed by that read", async () => {
    const context = contextOn({ files: { [url]: { body: PDF } } });

    const content = await fileContentOf({ mediaType: "application/pdf", url }, context);

    expect(content.sha256).toBe(sha256Of(PDF));
    expect(context.asked()).toEqual([url]);
  });

  it("a url file without a digest is pinned by the read: its sha256 is that of what came", async () => {
    const context = contextOn({ files: { [url]: { body: PNG } } });

    const pinned = await fileContentOf({ mediaType: "image/png", url }, context);

    expect(pinned.sha256).toBe(sha256Of(PNG));
    expect([...pinned.bytes]).toEqual([...PNG]);
  });

  it("with no allowedFileOrigins no file by url is fetched, and nothing is asked", async () => {
    const context = contextOn({ allowedOrigins: [], files: { [url]: { body: PDF } } });

    expect(
      await failureOf(fileContentOf({ mediaType: "application/pdf", url }, context)),
    ).toMatchObject({
      refusal: FileRefusal.OriginDenied,
    });
    expect(context.asked()).toEqual([]);
  });

  it("an origin not listed is refused; a redirect to one is refused too", async () => {
    const context = contextOn({
      files: { [url]: { status: 302, location: "https://evil.example/x.pdf" } },
    });

    expect(
      await failureOf(
        fileContentOf(
          { mediaType: "application/pdf", url: "https://other.example/a.pdf" },
          context,
        ),
      ),
    ).toMatchObject({
      refusal: FileRefusal.OriginDenied,
    });
    expect(
      await failureOf(fileContentOf({ mediaType: "application/pdf", url }, context)),
    ).toMatchObject({
      refusal: FileRefusal.OriginDenied,
    });
  });

  it("a url with a user or a password is refused", async () => {
    const context = contextOn();

    expect(
      await failureOf(
        fileContentOf(
          { mediaType: "application/pdf", url: "https://u:p@files.example/a.pdf" },
          context,
        ),
      ),
    ).toMatchObject({ refusal: FileRefusal.OriginDenied });
  });

  it("a private address, a NAT64 address and a link-local address are never fetched from", async () => {
    const origins = ["https://10.0.0.1", "https://[64:ff9b::a00:1]", "https://169.254.169.254"];
    const context = contextOn({ allowedOrigins: origins, transport: httpsFileTransport });

    for (const origin of origins)
      expect(
        await failureOf(
          fileContentOf({ mediaType: "application/pdf", url: `${origin}/a.pdf` }, context),
        ),
      ).toMatchObject({ refusal: FileRefusal.AddressDenied });
  });

  it("a download over maxFileSize stops there (too-large)", async () => {
    const big = new Uint8Array(4096).fill(0x25);
    const context = contextOn({ files: { [url]: { body: big } } });

    expect(
      await failureOf(fileContentOf({ mediaType: "application/pdf", url }, context)),
    ).toMatchObject({
      refusal: FileRefusal.TooLarge,
    });
  });

  it("a url that does not answer is unavailable (download-failed), a refusal is no unavailability", async () => {
    const context = contextOn({ files: {} });

    const failure = await failureOf(fileContentOf({ mediaType: "application/pdf", url }, context));

    expect(failure).toBeInstanceOf(FileError.Unavailable);
    expect(failure).not.toBeInstanceOf(FileError.Refused);
    expect(failure).toMatchObject({ reason: FileUnavailableReason.DownloadFailed });
  });

  it("a file by url that is not what it says is refused after its read", async () => {
    const context = contextOn({ files: { [url]: { body: PNG } } });

    expect(
      await failureOf(fileContentOf({ mediaType: "application/pdf", url }, context)),
    ).toMatchObject({
      refusal: FileRefusal.MediaTypeMismatch,
    });
  });
});
