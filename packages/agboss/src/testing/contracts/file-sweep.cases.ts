import { bytes as byteSize, type Milliseconds } from "../../units/index.js";
import { expect } from "vitest";
import {
  metadataOf,
  type FileMetadata,
  type FileOwnerCompletion,
  type FileRepository,
  type FileSweep,
  type NewFile,
} from "../../infrastructure/file.repository.js";
import type { ContractCase } from "./define.js";

/** The sweep of `FileRepository` (#1316): the files of the owners that completed, by ttl. */

const WORKFLOW = "contract-workflow";
const NINE = new Date("2026-01-05T09:00:00.000Z");
const TEN = new Date("2026-01-05T10:00:00.000Z");
const DAY_LATER = new Date("2026-01-06T09:00:00.000Z");

const ms = (value: number): Milliseconds => value as Milliseconds;

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

const ofText = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  return {
    bytes,
    sizeBytes: byteSize(bytes.byteLength),
    sha256: text
      .padEnd(64, "a")
      .replace(/[^0-9a-f]/g, "a")
      .slice(0, 64),
  };
};

const completion = (ownerId: string, at: Date, tenantId = "default"): FileOwnerCompletion => ({
  tenantId,
  ownerId,
  workflow: WORKFLOW,
  completedAt: at,
});

const sweepAt = (now: Date, ttl: number): FileSweep => ({
  now,
  cutoffsByWorkflow: new Map([[WORKFLOW, new Date(now.getTime() - ttl)]]),
});

const SWEEP_CASES: readonly ContractCase<FileRepository>[] = [
  {
    name: "#1316: a file of an owner that has not completed is never swept, however old",
    run: async ({ first, second }) => {
      await first.save(fileOf());

      const removed = await second.deleteExpired(sweepAt(DAY_LATER, 1));

      expect(removed).toBe(0);
      expect(await first.findMetadata(fileOf())).toBeDefined();
    },
  },
  {
    name: "#1316: a completed owner's files go once their workflow's cutoff is past it (strictly), counted; another owner's and another tenant's stay",
    run: async ({ first, second }) => {
      await first.save(fileOf());
      await first.save(fileOf({ fileId: "task-1.1", text: "cccc" }));
      await first.save(fileOf({ fileId: "task-2.0", ownerId: "task-2" }));
      await first.save(fileOf({ tenantId: "acme", fileId: "task-1.0" }));
      await first.markOwnerCompleted(completion("task-1", NINE));
      await first.markOwnerCompleted(completion("task-1", NINE, "acme"));

      // the cutoff is the very moment it completed: not yet up
      expect(await second.deleteExpired(sweepAt(TEN, 60 * 60_000))).toBe(0);
      expect(await first.findMetadata(fileOf())).toBeDefined();
      // an hour and a minute later
      const removed = await second.deleteExpired(
        sweepAt(new Date(TEN.getTime() + 60_000), 3_600_000),
      );

      expect(removed).toBe(3);
      expect(await first.findMetadata(fileOf())).toBeUndefined();
      expect(await first.findBytes({ tenantId: "default", fileId: "task-1.1" })).toBeUndefined();
      expect(await first.findMetadata({ tenantId: "acme", fileId: "task-1.0" })).toBeUndefined();
      expect(await first.findMetadata({ tenantId: "default", fileId: "task-2.0" })).toBeDefined();
      expect(await second.deleteExpired(sweepAt(DAY_LATER, 1))).toBe(0);
    },
  },
  {
    name: "#1316: a workflow with no cutoff (Ttl.Forever) keeps its files, except one with a ttl of its own, up from completedAt + ttl; the owner's other files stay",
    run: async ({ first, second }) => {
      await first.save(fileOf({ ttl: ms(30 * 60_000) }));
      await first.save(fileOf({ fileId: "task-1.1", text: "cccc" }));
      await first.markOwnerCompleted(completion("task-1", NINE));
      const none = new Map<string, Date>();
      const at = (time: Date) => ({ now: time, cutoffsByWorkflow: none });

      expect(await second.deleteExpired(at(new Date(NINE.getTime() + 30 * 60_000)))).toBe(0);
      expect(await second.deleteExpired(at(new Date(NINE.getTime() + 30 * 60_000 + 1)))).toBe(1);

      expect(await first.findMetadata(fileOf())).toBeUndefined();
      expect(await first.findMetadata({ tenantId: "default", fileId: "task-1.1" })).toBeDefined();
      expect(await second.deleteExpired(at(DAY_LATER))).toBe(0);
    },
  },
  {
    name: "#1316: a shorter ttl of a file goes first and its siblings follow at the workflow's cutoff; every sweep after counts none",
    run: async ({ first, second }) => {
      await first.save(fileOf({ ttl: ms(10 * 60_000) }));
      await first.save(fileOf({ fileId: "task-1.1", text: "cccc" }));
      await first.markOwnerCompleted(completion("task-1", NINE));

      const early = await second.deleteExpired(
        sweepAt(new Date(NINE.getTime() + 11 * 60_000), 3_600_000),
      );
      const late = await second.deleteExpired(
        sweepAt(new Date(NINE.getTime() + 61 * 60_000), 3_600_000),
      );

      expect([early, late]).toEqual([1, 1]);
      expect(await first.findMetadata({ tenantId: "default", fileId: "task-1.1" })).toBeUndefined();
      expect(await second.deleteExpired(sweepAt(DAY_LATER, 3_600_000))).toBe(0);
    },
  },
  {
    name: "#1316: markOwnerCompleted twice keeps the first moment: a tree ended again is not a later end",
    run: async ({ first, second }) => {
      await first.save(fileOf());
      await first.markOwnerCompleted(completion("task-1", NINE));
      await second.markOwnerCompleted(completion("task-1", new Date(NINE.getTime() + 50 * 60_000)));

      const removed = await second.deleteExpired(
        sweepAt(new Date(NINE.getTime() + 61 * 60_000), 3_600_000),
      );

      expect(removed).toBe(1);
    },
  },
  {
    name: "#904: a tenant id of 200 characters, three-byte ones too: its file is saved, read, swept after its owner completed",
    run: async ({ first, second }) => {
      const tenants = ["t".repeat(200), "€".repeat(200)];
      for (const tenantId of tenants) await first.save(fileOf({ tenantId }));
      for (const tenantId of tenants)
        await first.markOwnerCompleted(completion("task-1", NINE, tenantId));

      const read = await Promise.all(
        tenants.map((tenantId) => second.findMetadata({ tenantId, fileId: "task-1.0" })),
      );
      const removed = await second.deleteExpired(sweepAt(DAY_LATER, 3_600_000));

      expect(read).toEqual(tenants.map((tenantId) => metaOf(fileOf({ tenantId }))));
      expect(removed).toBe(2);
      for (const tenantId of tenants)
        expect(await first.findMetadata({ tenantId, fileId: "task-1.0" })).toBeUndefined();
    },
  },
  {
    name: "#904: the longest ids together — a tenant, an owner and a file id of 200 three-byte characters, a long filename, a long workflow name: saved, read, swept by the workflow cutoff and by a ttl of its own",
    run: async ({ first, second }) => {
      const owner = { tenantId: "€".repeat(200), ownerId: "₤".repeat(200) };
      const workflow = "w".repeat(200);
      const file = fileOf({
        ...owner,
        fileId: `${"₿".repeat(198)}.0`,
        filename: "я".repeat(255),
        ttl: ms(60_000),
      });
      await first.save(file);
      await first.save({
        ...file,
        fileId: `${"₿".repeat(198)}.1`,
        ttl: undefined,
        ...ofText("dddd"),
      });
      await first.markOwnerCompleted({ ...owner, workflow, completedAt: NINE });
      const cutoffs = (time: Date, ttl: number) => ({
        now: time,
        cutoffsByWorkflow: new Map([[workflow, new Date(time.getTime() - ttl)]]),
      });

      const meta = await second.findMetadata(file);
      const bytes = await second.findBytes(file);
      const early = await second.deleteExpired(
        cutoffs(new Date(NINE.getTime() + 61_000), 3_600_000),
      );
      const late = await second.deleteExpired(cutoffs(DAY_LATER, 3_600_000));

      expect(meta).toEqual(metaOf(file));
      expect(Buffer.from(bytes ?? [])).toEqual(Buffer.from(file.bytes));
      expect([early, late]).toEqual([1, 1]);
      expect(await first.findMetadata(file)).toBeUndefined();
    },
  },
];

/** The sweep's cases, for `fileContract`. */
export const fileSweepCases = (): readonly ContractCase<FileRepository>[] => SWEEP_CASES;
