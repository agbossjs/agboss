/**
 * #1316a: the files are named without the A2A prefix — `FileDto` / `@File` / `WorkflowFinishFile(s)Dto`
 * in `/dto`, `Files` / `FileRepository` / `FileError` in the root; one `FileError` family for the
 * A2A and the model file paths; `A2APart.fromFile` is the wire's part of a file. The old names are
 * on no entry. Every async method of `Files` rejects (R7): a bad argument is never a sync throw.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as a2a from "../../src/a2a/index.js";
import * as dto from "../../src/dto/index.js";
import * as internal from "../../src/internal.js";
import * as root from "../../src/index.js";
import { Files } from "../../src/a2a/files/files.service.js";
import { FileError } from "../../src/core/error-families/remote-errors.js";
import { fieldsOf } from "../../src/dto/metadata.js";
import { File, FileDto, WorkflowFinishFileDto } from "../../src/dto/index.js";
import { InlineFileRepository } from "../../src/infrastructure/file.repository.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { inTestFrame } from "../helpers/frame.js";
import { PDF } from "../a2a/files/support.js";

const API = join(import.meta.dirname, "../../api");
const reports = readdirSync(API)
  .filter((file) => file.endsWith(".api.md"))
  .map((file) => [file, readFileSync(join(API, file), "utf8")] as const);

const REMOVED = [
  "A2AFileDto",
  "A2AFiles",
  "A2AFileContent",
  "A2AFileReference",
  "A2AFileField",
  "A2AFileSource",
  "A2AFileRepository",
  "InMemoryA2AFileRepository",
  "LocalDiskA2AFileRepository",
  "S3A2AFileRepository",
  "A2AFileKey",
  "A2AFileMetadata",
  "A2AFileOwner",
  "NewA2AFile",
  "A2AFileRefusal",
  "A2AFileUnavailableReason",
  "A2AFileRefusedError",
  "A2AFileUnavailableError",
  "A2AFileConflictError",
  "ModelFileRefusedError",
  "ModelFileUnavailableError",
  "ModelFileRefusal",
  "ModelFileUnavailableReason",
  "A2AClientFile",
  "A2AReceivedFile",
  "AttachmentDto",
  "a2aFileContract",
];

describe("#1316a: the A2A file names are gone", () => {
  it.each(REMOVED)("%s is named by no entry", (name) => {
    for (const entry of [root, a2a, dto, internal]) expect(entry).not.toHaveProperty(name);
    for (const [file, report] of reports)
      expect(report, file).not.toMatch(new RegExp(`\\b${name}\\b`));
  });

  it("the new names are on their entries", () => {
    expect(dto).toMatchObject({ File: expect.any(Function), FileDto: expect.any(Function) });
    expect(dto).toHaveProperty("WorkflowFinishFileDto");
    expect(dto).toHaveProperty("WorkflowFinishFilesDto");
    expect(root).toMatchObject({ Files: expect.any(Function), FileError: expect.any(Function) });
    expect(root).toHaveProperty("FileRepository");
    expect(root).toHaveProperty("FileRefusal");
    expect(root).toHaveProperty("FileUnavailableReason");
    expect(a2a).toHaveProperty("A2APart");
  });
});

describe("#1316a: FileDto and @File", () => {
  it("fromBytes holds the bytes inline with their digest and size; fromUrl holds the url only", () => {
    const bytes = new TextEncoder().encode("hello");

    const held = FileDto.fromBytes(bytes, {
      mediaType: "Text/Plain; charset=utf-8",
      filename: "a.txt",
    });
    const linked = FileDto.fromUrl("https://files.example/a.txt", { mediaType: "text/plain" });

    expect(held).toEqual({
      mediaType: "text/plain",
      filename: "a.txt",
      sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      sizeBytes: 5,
      inline: "aGVsbG8=",
    });
    expect(linked).toEqual({ mediaType: "text/plain", url: "https://files.example/a.txt" });
  });

  it("@File is a nested FileDto field, optional with `optional: true`; @List(FileDto) holds several", () => {
    class Request {
      @File({ prompt: "the photo" })
      photo!: FileDto;

      @File({ prompt: "the extra", optional: true })
      extra?: FileDto;
    }

    expect(fieldsOf(Request).map((field) => [field.name, field.kind, field.optional])).toEqual([
      ["photo", "nested", false],
      ["extra", "nested", true],
    ]);
    expect(fieldsOf(WorkflowFinishFileDto).map((field) => field.name)).toEqual(["file"]);
  });
});

describe("#1316a R7: Files rejects, it never throws synchronously", () => {
  const files = new Files(new InlineFileRepository(), new VirtualClock(new Date(0)));

  it("save and read of a bad argument are rejected promises", async () => {
    const save = files.save(undefined as never);
    const read = files.read(undefined as never);

    expect(save).toBeInstanceOf(Promise);
    expect(read).toBeInstanceOf(Promise);
    await expect(save).rejects.toBeInstanceOf(Error);
    await expect(read).rejects.toBeInstanceOf(Error);
  });

  it("outside an execution a save is FileError.Refused and a read FileError.Unavailable", async () => {
    await expect(files.save({ bytes: PDF, mediaType: "application/pdf" })).rejects.toBeInstanceOf(
      FileError.Refused,
    );
    await expect(
      files.read(FileDto.fromBytes(PDF, { mediaType: "application/pdf" })),
    ).rejects.toBeInstanceOf(FileError.Unavailable);
  });

  it("inside an execution a bad media type is refused with the one family's code", async () => {
    const refused = await inTestFrame(() =>
      files.save({ bytes: PDF, mediaType: "application/x-nope" }).catch((error: unknown) => error),
    );

    expect(refused).toBeInstanceOf(FileError.Refused);
    expect(refused).toMatchObject({ code: "files.refused", kind: "refused" });
  });
});
