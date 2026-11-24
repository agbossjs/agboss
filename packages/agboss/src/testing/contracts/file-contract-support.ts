import { bytes as byteSize, type Milliseconds } from "../../units/index.js";
import {
  metadataOf,
  type FileMetadata,
  type FileOwnerCompletion,
  type FileSweep,
  type NewFile,
} from "../../infrastructure/file.repository.js";

/** The sweep of `FileRepository` (#1316): the files of the owners that completed, by ttl. */

export const WORKFLOW = "contract-workflow";
export const NINE = new Date("2026-01-05T09:00:00.000Z");
export const TEN = new Date("2026-01-05T10:00:00.000Z");
export const DAY_LATER = new Date("2026-01-06T09:00:00.000Z");

export const ms = (value: number): Milliseconds => value as Milliseconds;

export const fileOf = (fields: Partial<NewFile> & { readonly text?: string } = {}): NewFile => {
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

export const metaOf = (file: NewFile): FileMetadata => metadataOf(file);

export const ofText = (
  text: string,
): { bytes: Uint8Array; sizeBytes: ReturnType<typeof byteSize>; sha256: string } => {
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

export const completion = (
  ownerId: string,
  at: Date,
  tenantId = "default",
): FileOwnerCompletion => ({
  tenantId,
  ownerId,
  workflow: WORKFLOW,
  completedAt: at,
});

export const sweepAt = (now: Date, ttl: number): FileSweep => ({
  now,
  cutoffsByWorkflow: new Map([[WORKFLOW, new Date(now.getTime() - ttl)]]),
});
