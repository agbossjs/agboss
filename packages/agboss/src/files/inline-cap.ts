import { bytes as byteSize, kilobytes } from "../units/index.js";
import type { FileDto } from "../dto/standard/file.js";
import { isInlineFileStore, type FileRepository } from "../infrastructure/file.repository.js";
import { createHash } from "node:crypto";
import { FileRefusal, fileRefused, fileUnavailable, FileUnavailableReason } from "./file-errors.js";
import type { Milliseconds } from "../units/index.js";

/**
 * The inline cap (#1316): bytes held inline in a descriptor ride in checkpoints and records, so a
 * file over 64 KB, and all the inline files of one payload over 256 KB together, are offloaded to the
 * application's `FileRepository` (largest first) — or, with none listed, refused with
 * `FileError.Refused` (`FileRefusal.InlineTooLarge`). No 0.1.0 payload is let through.
 */

/** The most bytes of one file held inline. */
export const MAX_INLINE_FILE_BYTES = kilobytes(64);

/** The most inline bytes of all the files of one payload. */
export const MAX_INLINE_PAYLOAD_BYTES = kilobytes(256);

/** Where offloaded files go, and under whom. */
export interface InlineOffload {
  readonly store: FileRepository;
  readonly tenantId: string;
  /** The root execution's id: the files age from its end. */
  readonly ownerId: string;
  readonly now: Date;
  /** The `@FilePolicy.ttl` of the saving workflow, when finite. */
  readonly ttl?: Milliseconds | undefined;
}

const inlineSizeOf = (file: FileDto): number =>
  file.inline === undefined ? 0 : Buffer.from(file.inline, "base64").byteLength;

/** The inline files that must leave a payload: every one over the file cap, then the largest until it fits. */
export function filesToOffload(files: readonly FileDto[]): readonly FileDto[] {
  const sized = files
    .filter((file) => file.inline !== undefined)
    .map((file) => ({ file, size: inlineSizeOf(file) }));
  const out = sized.filter(({ size }) => size > MAX_INLINE_FILE_BYTES);
  const left = sized
    .filter(({ size }) => size <= MAX_INLINE_FILE_BYTES)
    .sort((a, b) => b.size - a.size);
  let total = left.reduce((sum, { size }) => sum + size, 0);
  for (const each of left) {
    if (total <= MAX_INLINE_PAYLOAD_BYTES) break;
    out.push(each);
    total -= each.size;
  }
  return out.map(({ file }) => file);
}

/**
 * Refuses (`FileRefusal.InlineTooLarge`) the inline files that are over the caps when the store keeps
 * nothing (the inline default): nothing is written, so a caller checks before it writes anything.
 */
export function assertInlineFits(files: readonly FileDto[], store: FileRepository): void {
  const leaving = filesToOffload(files);
  if (leaving.length > 0 && isInlineFileStore(store))
    throw fileRefused({
      refusal: FileRefusal.InlineTooLarge,
      sizeBytes: Math.max(...leaving.map(inlineSizeOf)),
    });
}

/**
 * Brings the inline files of one payload under the cap, in place: each that must leave is saved in
 * the store under `<ownerId>.<sha256>` and its descriptor holds that `fileId` instead of `inline`.
 * With no file store, refuses before anything changes.
 */
export async function offloadedInlineFiles(
  files: readonly FileDto[],
  offload: InlineOffload,
): Promise<void> {
  const leaving = filesToOffload(files);
  if (leaving.length === 0) return;
  assertInlineFits(files, offload.store);
  // the digest is the bytes' own, never the caller's claim: a key from a claimed digest would let a
  // caller poison another file's; every file is checked before the first is saved
  const checked = leaving.map((file) => ownBytesOf(file));
  for (const { file, bytes, sha256 } of checked) {
    const fileId = `${offload.ownerId}.${sha256}`;
    await offload.store.save({
      tenantId: offload.tenantId,
      fileId,
      ownerId: offload.ownerId,
      mediaType: file.mediaType,
      ...(file.filename === undefined ? {} : { filename: file.filename }),
      sha256,
      sizeBytes: byteSize(bytes.byteLength),
      createdAt: offload.now,
      ...(offload.ttl === undefined ? {} : { ttl: offload.ttl }),
      bytes,
    });
    delete file.inline;
    file.fileId = fileId;
    file.sha256 = sha256;
    file.sizeBytes = bytes.byteLength;
  }
}

const SHA256 = /^[0-9a-f]{64}$/;

/** A file's decoded bytes with their own digest; a claimed digest or size that differs is refused. */
function ownBytesOf(file: FileDto): {
  readonly file: FileDto;
  readonly bytes: Uint8Array;
  readonly sha256: string;
} {
  const bytes = new Uint8Array(Buffer.from(file.inline ?? "", "base64"));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const claimed = file.sha256;
  const isDigestWrong = claimed !== undefined && (!SHA256.test(claimed) || claimed !== sha256);
  const isSizeWrong = file.sizeBytes !== undefined && file.sizeBytes !== bytes.byteLength;
  if (isDigestWrong || isSizeWrong)
    throw fileUnavailable({ reason: FileUnavailableReason.DigestMismatch });
  return { file, bytes, sha256 };
}
