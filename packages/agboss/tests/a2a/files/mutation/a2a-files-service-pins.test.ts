/**
 * #1244: `Files` and its work, pinned: the exact descriptor a save and `fromUrl` give, the
 * size limit at the byte, and each refusal's reason and facts.
 */
import { FileError } from "../../../../src/core/error-families/remote-errors.js";
import { describe, expect, it } from "vitest";
import { FileRefusal } from "../../../../src/files/file-errors.js";
import { Files } from "../../../../src/a2a/files/files.service.js";
import { InlineFileRepository } from "../../../../src/infrastructure/file.repository.js";
import { InMemoryFileRepository } from "../../../../src/infrastructure/in-memory-file.repository.js";
import { InMemoryDatabase } from "../../../../src/infrastructure/in-memory-database.js";
import { VirtualClock } from "../../../../src/testing/clock.js";
import { inTestFrame } from "../../../helpers/frame.js";
import { ComponentOptions } from "../../../../src/components/component-options.js";

const clock = new VirtualClock(new Date("2026-01-05T09:00:00.000Z"));
const inline = new Files(new InlineFileRepository(), clock, ComponentOptions.none);
const stored = () =>
  new Files(new InMemoryFileRepository(new InMemoryDatabase()), clock, ComponentOptions.none);
const LIMIT = 64 * 1024;
const text = (size: number): Uint8Array => new TextEncoder().encode("a".repeat(size));

async function refusalOf(work: Promise<unknown>): Promise<FileError.Refused> {
  try {
    await work;
  } catch (error) {
    if (error instanceof FileError.Refused) return error;
    throw error;
  }
  throw new Error("not refused");
}

describe("fromUrl", () => {
  it("is the media type's essence, the name when given and the url, nothing else", () => {
    const named = inline.fromUrl("https://f.example/a.txt", {
      mediaType: " Text/Plain; charset=utf-8",
      filename: "a.txt",
    });
    const unnamed = inline.fromUrl("https://f.example/a.txt", { mediaType: "text/plain" });

    expect(named).toStrictEqual({
      mediaType: "text/plain",
      filename: "a.txt",
      url: "https://f.example/a.txt",
    });
    expect(unnamed).toStrictEqual({ mediaType: "text/plain", url: "https://f.example/a.txt" });
  });

  it("only an https: url: url-invalid, with that refusal and nothing more", () => {
    for (const url of [
      "http://f.example/a",
      "not a url",
      "",
      "ftp://f.example/a",
      "file:///etc/x",
    ]) {
      let thrown: unknown;
      try {
        inline.fromUrl(url, { mediaType: "text/plain" });
      } catch (error) {
        thrown = error;
      }
      expect(thrown, url).toBeInstanceOf(FileError.Refused);
      expect((thrown as FileError.Refused).refusal).toBe(FileRefusal.UrlInvalid);
      expect((thrown as FileError.Refused).details).toStrictEqual({ refusal: "url-invalid" });
    }
  });
});

describe("save", () => {
  it("inline: the exact descriptor, with the name only when given", async () => {
    const named = await inTestFrame(() =>
      inline.save({ bytes: text(3), mediaType: "Text/Plain", filename: "a.txt" }),
    );
    const unnamed = await inTestFrame(() =>
      inline.save({ bytes: text(3), mediaType: "text/plain" }),
    );

    expect(named).toStrictEqual({
      mediaType: "text/plain",
      filename: "a.txt",
      sha256: "9834876dcfb05cb167a5c24953eba58c4ac89b1adf57f28f2f9d09af107ee8f0",
      sizeBytes: 3,
      inline: "YWFh",
    });
    expect(unnamed).toStrictEqual({
      mediaType: "text/plain",
      sha256: "9834876dcfb05cb167a5c24953eba58c4ac89b1adf57f28f2f9d09af107ee8f0",
      sizeBytes: 3,
      inline: "YWFh",
    });
  });

  it("with a store: the descriptor holds the file id (owner.sha256), never the bytes", async () => {
    const file = await inTestFrame(() =>
      stored().save({ bytes: text(3), mediaType: "text/plain", filename: "a.txt" }),
    );
    const unnamed = await inTestFrame(() =>
      stored().save({ bytes: text(3), mediaType: "text/plain" }),
    );

    expect(file.inline).toBeUndefined();
    expect(file.fileId).toMatch(
      /^.+\.9834876dcfb05cb167a5c24953eba58c4ac89b1adf57f28f2f9d09af107ee8f0$/,
    );
    expect(file).toStrictEqual({
      mediaType: "text/plain",
      filename: "a.txt",
      sha256: "9834876dcfb05cb167a5c24953eba58c4ac89b1adf57f28f2f9d09af107ee8f0",
      sizeBytes: 3,
      fileId: file.fileId,
    });
    expect(unnamed).toStrictEqual({
      mediaType: "text/plain",
      sha256: "9834876dcfb05cb167a5c24953eba58c4ac89b1adf57f28f2f9d09af107ee8f0",
      sizeBytes: 3,
      fileId: unnamed.fileId,
    });
  });

  it("exactly the limit is kept, one byte more is too-large with its size", async () => {
    const atLimit = await inTestFrame(() =>
      inline.save({ bytes: text(LIMIT), mediaType: "text/plain" }),
    );
    const refused = await refusalOf(
      inTestFrame(() => inline.save({ bytes: text(LIMIT + 1), mediaType: "text/plain" })),
    );

    expect(atLimit.sizeBytes).toBe(LIMIT);
    expect(refused.refusal).toBe(FileRefusal.TooLarge);
    expect(refused.sizeBytes).toBe(LIMIT + 1);
    expect(refused.details).toStrictEqual({ refusal: "too-large", sizeBytes: LIMIT + 1 });
  });

  it("each refusal names its reason and only its own facts", async () => {
    const outside = await refusalOf(inline.save({ bytes: text(1), mediaType: "text/plain" }));
    const notTaken = await refusalOf(
      inTestFrame(() => inline.save({ bytes: text(1), mediaType: "Application/ZIP; x=y" })),
    );
    const mismatch = await refusalOf(
      inTestFrame(() => inline.save({ bytes: text(5), mediaType: "application/pdf" })),
    );

    expect(outside.details).toStrictEqual({ refusal: "outside-execution" });
    expect(notTaken.details).toStrictEqual({ refusal: "media-type", mediaType: "application/zip" });
    expect(mismatch.details).toStrictEqual({
      refusal: "media-type-mismatch",
      mediaType: "application/pdf",
    });
  });
});
