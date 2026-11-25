import { bytes as byteSize } from "../../units/index.js";
import { expect } from "vitest";
import { FileError } from "../../core/error-families/remote-errors.js";
import {
  metadataOf,
  type FileMetadata,
  type FileRepository,
  type NewFile,
} from "../../infrastructure/file.repository.js";
import { fileOrphanCases } from "./file-orphan.cases.js";
import { fileSweepCases } from "./file-sweep.cases.js";
import { pingOf, registerContract, type ContractCase } from "./define.js";
import type { ContractTarget } from "./instance-context.js";

const NINE = new Date("2026-01-05T09:00:00.000Z");
const TEN = new Date("2026-01-05T10:00:00.000Z");

/** A file of `text`'s bytes, its digest given (the store never computes one). */
const fileOf = (fields: Partial<NewFile> & { readonly text?: string } = {}): NewFile => {
  const bytes = new TextEncoder().encode(fields.text ?? "%PDF-1.7 contract");
  return {
    tenantId: "default",
    fileId: "task-1.0",
    ownerId: "task-1",
    mediaType: "application/pdf",
    filename: "contract.pdf",
    sha256: (fields.text ?? "a")
      .padEnd(64, "0")
      .slice(0, 64)
      .replace(/[^0-9a-f]/g, "a"),
    sizeBytes: byteSize(bytes.byteLength),
    createdAt: NINE,
    bytes,
    ...fields,
  };
};

const metaOf = (file: NewFile): FileMetadata => metadataOf(file);

const FILE_CASES: readonly ContractCase<FileRepository>[] = [
  ...fileSweepCases(),
  ...fileOrphanCases(),
  {
    name: "a saved file is read back on another instance: its bytes and its metadata",
    run: async ({ first, second }) => {
      const file = fileOf();
      await first.save(file);

      expect(Buffer.from((await second.findBytes(file)) ?? [])).toEqual(Buffer.from(file.bytes));
      expect(await second.findMetadata(file)).toEqual(metaOf(file));
    },
  },
  {
    name: "a file is the tenant's: another tenant's key finds nothing",
    run: async ({ first, second }) => {
      await first.save(fileOf());

      expect(await second.findBytes({ tenantId: "acme", fileId: "task-1.0" })).toBeUndefined();
      expect(await second.findMetadata({ tenantId: "acme", fileId: "task-1.0" })).toBeUndefined();
      expect(
        await second.findMetadata({ tenantId: "default", fileId: "task-1.1" }),
      ).toBeUndefined();
    },
  },
  {
    name: "a file never changes: the same bytes again do nothing, other bytes are a conflict",
    run: async ({ first, second }) => {
      const file = fileOf();
      await first.save(file);

      await second.save(file);
      const other = fileOf({ text: "bbbb other bytes", sizeBytes: byteSize(16) });
      await expect(second.save(other)).rejects.toBeInstanceOf(FileError.Conflict);
      expect(await first.findMetadata(file)).toEqual(metaOf(file));
    },
  },
  {
    name: "two saves of one file at once: one is kept, both resolve",
    run: async ({ first, second }) => {
      const file = fileOf();

      await Promise.all([first.save(file), second.save(file)]);

      expect(await first.findMetadata(file)).toEqual(metaOf(file));
    },
  },
  {
    name: "deleteByOwner removes an owner's files together, another owner's and another tenant's stay",
    run: async ({ first, second }) => {
      await first.save(fileOf());
      await first.save(fileOf({ fileId: "task-1.1", text: "cccc" }));
      await first.save(fileOf({ fileId: "task-2.0", ownerId: "task-2", createdAt: TEN }));
      await first.save(fileOf({ tenantId: "acme", fileId: "task-1.0" }));

      await second.deleteByOwner({ tenantId: "default", ownerId: "task-1" });

      expect(await first.findMetadata({ tenantId: "default", fileId: "task-1.0" })).toBeUndefined();
      expect(await first.findBytes({ tenantId: "default", fileId: "task-1.1" })).toBeUndefined();
      expect(await first.findMetadata({ tenantId: "default", fileId: "task-2.0" })).toBeDefined();
      expect(await first.findMetadata({ tenantId: "acme", fileId: "task-1.0" })).toBeDefined();
    },
  },
];

/**
 * `FileRepository` (#859): the A2A tasks' files by `(tenantId, fileId)`. A file saved on one
 * instance is read on another, bytes and metadata; it is its tenant's; it never changes (the same
 * bytes again do nothing, others are `FileError.Conflict`); of two saves at once one is kept;
 * the sweep (`deleteExpired`) removes, and counts, the files of the owners that completed and whose
 * time is up — their workflow's cutoff, or a file's own `ttl` — and never a file of an owner that has not.
 */
export function fileContract(target: ContractTarget<FileRepository>): void {
  registerContract("A2A file contract", target, [{ cases: FILE_CASES }], pingOf);
}
