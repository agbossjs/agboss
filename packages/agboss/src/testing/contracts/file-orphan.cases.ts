import { expect } from "vitest";
import type { FileRepository } from "../../infrastructure/file.repository.js";
import type { ContractCase } from "./define.js";
import { completion, fileOf, NINE, TEN } from "./file-contract-support.js";

/** The sweep of orphans of `FileRepository` (#1316). */

const ORPHAN_CASES: readonly ContractCase<FileRepository>[] = [
  {
    name: "#1316: an orphan — files of an owner never marked completed, older than the cutoff, with no live execution — is swept and counted; a live owner's file of the same age, a younger one and a completed owner's stay",
    run: async ({ first, second }) => {
      await first.save(fileOf({ fileId: "orphan.0", ownerId: "orphan" }));
      await first.save(fileOf({ fileId: "orphan.1", ownerId: "orphan", text: "cccc" }));
      await first.save(fileOf({ fileId: "live.0", ownerId: "live" }));
      await first.save(fileOf({ fileId: "young.0", ownerId: "young", createdAt: TEN }));
      await first.save(fileOf({ fileId: "done.0", ownerId: "done" }));
      await first.markOwnerCompleted(completion("done", NINE));
      const sweep = {
        createdBefore: new Date("2026-01-05T09:30:00.000Z"),
        isLive: (owner: { readonly ownerId: string }) => Promise.resolve(owner.ownerId === "live"),
      };

      const removed = await second.deleteOrphans(sweep);

      expect(removed).toBe(2);
      expect(await first.findMetadata({ tenantId: "default", fileId: "orphan.0" })).toBeUndefined();
      expect(await first.findBytes({ tenantId: "default", fileId: "orphan.1" })).toBeUndefined();
      for (const fileId of ["live.0", "young.0", "done.0"])
        expect(await first.findMetadata({ tenantId: "default", fileId })).toBeDefined();
      expect(await second.deleteOrphans(sweep)).toBe(0);
    },
  },
];

/** The orphan sweep's cases, for `fileContract`. */
export const fileOrphanCases = (): readonly ContractCase<FileRepository>[] => ORPHAN_CASES;
