import { createHash } from "node:crypto";
import type { A2AFileMetadata, A2AFileOwner } from "../a2a-file.repository.js";

/**
 * How `S3A2AFileRepository` lays its files out in a bucket (#859, #904): every key within what S3
 * and MinIO take — a segment at most 255 bytes, a key at most 1024 — for every valid id, and a
 * file's metadata in its object's body, never a header (user metadata is at most 2 KB there).
 *
 * An id is base64url (no id is ever a path of its own) cut into pieces of at most 254 characters,
 * each but the last ending with `.` (never a base64url character); one that would take more than
 * `MAX_ID_LENGTH` is its digest instead, `h.` + the base64url SHA-256 of its UTF-8 — decided by
 * the id alone, so every key of one tenant, owner or file names it the same way. With the prefix at
 * most `MAX_PREFIX_BYTES`, the longest key — an owner's index entry — stays within 1024 bytes.
 */

/** The longest piece of an id in a key: with its mark, a segment of 255 bytes. */
const PIECE = 254;

/** The most an id takes in a key; past it, its digest (45 characters). */
const MAX_ID_LENGTH = 300;

/** The width of a save's time in an owner's index key: sorted as text, in time order. */
export const TIME_WIDTH = 15;

/** The longest prefix: `owners/` + three ids + a time + their slashes leave the rest of 1024. */
export const MAX_PREFIX_BYTES = 1024 - ("owners/".length + 3 * MAX_ID_LENGTH + TIME_WIDTH + 3);

const DIGEST = /^h\.[\w-]{43}$/;

/** An id's part in a key: its pieces, or its digest. */
export function segmentOf(text: string): string {
  const encoded = Buffer.from(text, "utf8").toString("base64url");
  const pieces: string[] = [];
  for (let at = 0; at < encoded.length; at += PIECE) pieces.push(encoded.slice(at, at + PIECE));
  const joined = pieces.join("./");
  if (joined.length <= MAX_ID_LENGTH) return joined;
  return `h.${createHash("sha256").update(text, "utf8").digest("base64url")}`;
}

/** The id a key's part names; `undefined` for a digest (the id is read from its entry's body). */
export const textOf = (segment: string): string | undefined =>
  DIGEST.test(segment)
    ? undefined
    : Buffer.from(segment.replaceAll("./", ""), "base64url").toString("utf8");

/** One id's part in a key, as `segmentOf` writes it. */
const ID = String.raw`(?:h\.[\w-]{43}|(?:[\w-]+\.\/)*[\w-]+)`;

/** An owner's index key below the prefix: `owners/<tenant>/<owner>/<saved at>/<file>`. */
const ENTRY = new RegExp(String.raw`^owners\/(${ID})\/(${ID})\/(\d+)\/(${ID})$`);

/** An owner's index entry as its key names it: its ids' parts and when its file was saved. */
export interface IndexEntry {
  readonly tenant: string;
  readonly owner: string;
  readonly savedAt: number;
  readonly file: string;
}

/** The entry a key below the prefix names; `undefined` for a key of no index entry. */
export function indexEntryOf(key: string): IndexEntry | undefined {
  const match = ENTRY.exec(key);
  if (match === null) return undefined;
  const [, tenant = "", owner = "", savedAt = "0", file = ""] = match;
  return { tenant, owner, savedAt: Number(savedAt), file };
}

/** An owner's folder of the index, below the prefix. */
export const ownerFolderOf = (owner: A2AFileOwner): string =>
  `owners/${segmentOf(owner.tenantId)}/${segmentOf(owner.ownerId)}/`;

/** A file's index entry below the prefix. */
export const indexKeyOf = (file: A2AFileMetadata): string =>
  `${ownerFolderOf(file)}${String(file.createdAt.getTime()).padStart(TIME_WIDTH, "0")}/${segmentOf(file.fileId)}`;

/** A file's object below the prefix, from its ids' parts. */
export const fileKeyOf = (tenant: string, file: string): string => `files/${tenant}/${file}`;

/** What a prefix breaks, if anything: it must leave room for the longest key. */
export function prefixProblemOf(prefix: string): string | undefined {
  const bytes = Buffer.byteLength(prefix, "utf8");
  return bytes > MAX_PREFIX_BYTES
    ? `a2aS3Prefix is ${String(bytes)} bytes: at most ${String(MAX_PREFIX_BYTES)} keep every key within S3's 1024`
    : undefined;
}

/** A file's metadata as kept: JSON, its time as ISO 8601. */
export type StoredMetadata = Omit<A2AFileMetadata, "createdAt"> & { readonly createdAt: string };

const NEWLINE = 0x0a;

/** A file's object: its metadata's JSON (no raw newline in it), a newline, then its bytes. */
export function objectBodyOf(stored: StoredMetadata, bytes: Uint8Array): Uint8Array {
  return Buffer.concat([Buffer.from(`${JSON.stringify(stored)}\n`, "utf8"), bytes]);
}

/** What the start of a file's object holds: its metadata, if the read reached its newline. */
export function storedMetadataOf(head: Uint8Array): StoredMetadata | undefined {
  const end = head.indexOf(NEWLINE);
  if (end < 0) return undefined;
  return JSON.parse(Buffer.from(head.subarray(0, end)).toString("utf8")) as StoredMetadata;
}

/** A file's bytes, from its whole object. */
export function fileBytesOf(body: Uint8Array): Uint8Array {
  return new Uint8Array(body.subarray(body.indexOf(NEWLINE) + 1));
}

/** An index entry's body: the owner it is of, so a digest's id is read back. */
export const entryBodyOf = (owner: A2AFileOwner): Uint8Array =>
  Buffer.from(JSON.stringify({ tenantId: owner.tenantId, ownerId: owner.ownerId }), "utf8");

/** The owner an index entry's body names. */
export const ownerOfEntryBody = (body: Uint8Array): A2AFileOwner => {
  const parsed = JSON.parse(Buffer.from(body).toString("utf8")) as A2AFileOwner;
  return { tenantId: parsed.tenantId, ownerId: parsed.ownerId };
};
