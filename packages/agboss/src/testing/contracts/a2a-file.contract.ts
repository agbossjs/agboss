import { expect } from "vitest";
import {
  A2AFileConflictError,
  metadataOf,
  type A2AFileMetadata,
  type A2AFileOwner,
  type A2AFileRepository,
  type NewA2AFile,
} from "../../infrastructure/a2a-file.repository.js";
import { pingOf, registerContract, type ContractCase } from "./define.js";
import type { ContractTarget } from "./instance-context.js";

const NINE = new Date("2026-01-05T09:00:00.000Z");
const TEN = new Date("2026-01-05T10:00:00.000Z");

/** A file of `text`'s bytes, its digest given (the store never computes one). */
const fileOf = (fields: Partial<NewA2AFile> & { readonly text?: string } = {}): NewA2AFile => {
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
    sizeBytes: bytes.byteLength,
    createdAt: NINE,
    bytes,
    ...fields,
  };
};

const metaOf = (file: NewA2AFile): A2AFileMetadata => metadataOf(file);

const FILE_CASES: readonly ContractCase<A2AFileRepository>[] = [
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
      const other = fileOf({ text: "bbbb other bytes", sizeBytes: 16 });
      await expect(second.save(other)).rejects.toBeInstanceOf(A2AFileConflictError);
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
    name: "the owners of files older than a cutoff, each once; an owner's files go together",
    run: async ({ first, second }) => {
      await first.save(fileOf());
      await first.save(fileOf({ fileId: "task-1.1", text: "cccc" }));
      await first.save(fileOf({ fileId: "task-2.0", ownerId: "task-2", createdAt: TEN }));
      await first.save(fileOf({ tenantId: "acme", fileId: "task-1.0" }));

      const owners = await second.findOwnersByCreatedAtBefore(
        new Date("2026-01-05T09:30:00.000Z"),
        10,
      );
      await second.deleteByOwner({ tenantId: "default", ownerId: "task-1" });

      expect(owners).toHaveLength(2);
      expect(owners).toEqual(
        expect.arrayContaining([
          { tenantId: "default", ownerId: "task-1" },
          { tenantId: "acme", ownerId: "task-1" },
        ]),
      );
      expect(await first.findMetadata({ tenantId: "default", fileId: "task-1.0" })).toBeUndefined();
      expect(await first.findBytes({ tenantId: "default", fileId: "task-1.1" })).toBeUndefined();
      expect(await first.findMetadata({ tenantId: "default", fileId: "task-2.0" })).toBeDefined();
      expect(await first.findMetadata({ tenantId: "acme", fileId: "task-1.0" })).toBeDefined();
    },
  },
  {
    name: "the owners are paged after the last one, at most the limit: every owner once, then none",
    run: async ({ first, second }) => {
      for (const owner of ["c", "a", "b", "d", "e"])
        await first.save(fileOf({ fileId: `${owner}.0`, ownerId: owner }));
      await first.save(fileOf({ fileId: "a.1", ownerId: "a", text: "dddd" }));

      const pages: (readonly A2AFileOwner[])[] = [];
      for (let after: A2AFileOwner | undefined, page = 0; page < 4; page += 1) {
        const owners = await second.findOwnersByCreatedAtBefore(TEN, 2, after);
        pages.push(owners);
        after = owners.at(-1);
      }

      expect(pages.map((owners) => owners.length)).toEqual([2, 2, 1, 0]);
      expect(
        pages
          .flat()
          .map((owner) => owner.ownerId)
          .sort(),
      ).toEqual(["a", "b", "c", "d", "e"]);
    },
  },
  {
    name: "#904: a tenant id of 200 characters, three-byte ones too: its file is saved, read, found by the sweep and removed",
    run: async ({ first, second }) => {
      const tenants = ["t".repeat(200), "€".repeat(200)];
      for (const tenantId of tenants) await first.save(fileOf({ tenantId }));

      const owners = await second.findOwnersByCreatedAtBefore(TEN, 10);
      const read = await Promise.all(
        tenants.map((tenantId) => second.findMetadata({ tenantId, fileId: "task-1.0" })),
      );
      for (const tenantId of tenants) await second.deleteByOwner({ tenantId, ownerId: "task-1" });

      expect(owners).toEqual(
        expect.arrayContaining(tenants.map((tenantId) => ({ tenantId, ownerId: "task-1" }))),
      );
      expect(read).toEqual(tenants.map((tenantId) => metaOf(fileOf({ tenantId }))));
      expect(await first.findOwnersByCreatedAtBefore(TEN, 10)).toEqual([]);
    },
  },
  {
    name: "a page holds a whole number of owners from 1: another limit is a RangeError",
    run: async ({ first }) => {
      await expect(first.findOwnersByCreatedAtBefore(TEN, 0)).rejects.toBeInstanceOf(RangeError);
      await expect(first.findOwnersByCreatedAtBefore(TEN, 1.5)).rejects.toBeInstanceOf(RangeError);
    },
  },
];

/**
 * `A2AFileRepository` (#859): the A2A tasks' files by `(tenantId, fileId)`. A file saved on one
 * instance is read on another, bytes and metadata; it is its tenant's; it never changes (the same
 * bytes again do nothing, others are `A2AFileConflictError`); of two saves at once one is kept;
 * the sweep finds the owners of files older than its cutoff and removes an owner's files together.
 */
export function a2aFileContract(target: ContractTarget<A2AFileRepository>): void {
  registerContract("A2A file contract", target, [{ cases: FILE_CASES }], pingOf);
}
