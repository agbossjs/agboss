import { describe, expectTypeOf, it } from "vitest";
import type { FileDto, FileFieldOptions, FilePayloadSource } from "../../src/dto/index.js";
import * as dto from "../../src/dto/index.js";
import * as a2a from "../../src/a2a/index.js";
import * as root from "../../src/index.js";
import type { Bytes } from "../../src/units/index.js";
import type {
  FileError,
  FileKey,
  FileMetadata,
  FileOwner,
  FileReference,
  FileRefusal,
  FileRepository,
  FileToSave,
  Files,
  NewFile,
} from "../../src/index.js";

/** #1316a: the file names without the A2A prefix, one error family, `Bytes` sizes in the store row. */
describe("#1316a: file names", () => {
  it("FileDto is the one descriptor; Files saves it and reads it", () => {
    expectTypeOf<Files["save"]>().parameters.toEqualTypeOf<[FileToSave]>();
    expectTypeOf<Files["save"]>().returns.toEqualTypeOf<Promise<FileDto>>();
    expectTypeOf<Files["read"]>().parameters.toEqualTypeOf<[FileDto]>();
    expectTypeOf<Files["read"]>().returns.toEqualTypeOf<Promise<Uint8Array>>();
    expectTypeOf<Files["fromUrl"]>().parameters.toEqualTypeOf<[string, FileReference]>();
    expectTypeOf<FileFieldOptions>().toEqualTypeOf<{ readonly prompt?: string | undefined }>();
  });

  it("the store's row has a `Bytes` size and `Date` times", () => {
    expectTypeOf<FileMetadata["sizeBytes"]>().toEqualTypeOf<Bytes>();
    expectTypeOf<FileMetadata["createdAt"]>().toEqualTypeOf<Date>();
    expectTypeOf<NewFile["bytes"]>().toEqualTypeOf<Uint8Array>();
    expectTypeOf<FileRepository["deleteByOwner"]>().parameters.toEqualTypeOf<[FileOwner]>();
    expectTypeOf<FileRepository["findBytes"]>().parameters.toEqualTypeOf<[FileKey]>();
  });

  it("a refused file is FileError.Refused with its refusal; a payload source is a string enum", () => {
    expectTypeOf<FileError.Refused["refusal"]>().toEqualTypeOf<FileRefusal>();
    expectTypeOf<FileError.Refused["sizeBytes"]>().toEqualTypeOf<Bytes | undefined>();
    expectTypeOf<`${FilePayloadSource}`>().toEqualTypeOf<"stored" | "inline" | "url">();
  });

  it("the removed names are compile errors", () => {
    // @ts-expect-error the A2A prefix is gone
    type _a = root.A2AFiles;
    // @ts-expect-error the A2A prefix is gone
    type _b = a2a.A2AFileDto;
    // @ts-expect-error moved to FileDto.fromBytes / FileDto.fromUrl
    type _c = typeof a2a.A2AClientFile;
    // @ts-expect-error the file descriptor is FileDto
    type _d = dto.AttachmentDto;
    // @ts-expect-error the one family is FileError
    type _e = root.ModelFileRefusedError;
    // @ts-expect-error the one family is FileError
    type _f = a2a.A2AFileConflictError;
    expectTypeOf<[_a, _b, _c, _d, _e, _f]>().not.toBeAny();
  });
});
