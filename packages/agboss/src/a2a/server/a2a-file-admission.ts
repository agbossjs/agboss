import type { A2AFileDto } from "../files/a2a-file.dto.js";
import { fetchedFile } from "../files/a2a-file-fetch.js";
import { isOfMediaType } from "../files/a2a-media-check.js";
import { httpsFileTransport } from "../files/a2a-file-transport.js";
import { isInlineFileStore } from "../../infrastructure/a2a-file.repository.js";
import type { A2AFileMetadata, NewA2AFile } from "../../infrastructure/a2a-file.repository.js";
import { sha256Of, type IncomingFile } from "./a2a-message-files.js";
import type { A2ARequestCaller, A2AServerParts } from "./a2a-server-parts.js";
import type { ServedSkill } from "./a2a-skills.js";
import { invalidParams } from "./a2a-wire-errors.js";

/**
 * A new message's files admitted (#859, the second stage): each file's bytes — sent `raw`, or
 * fetched by `url` once, during the admission, bound to the request's end and the fetch timeout —
 * checked against its declared media type (`-32602 a2a.media-type-mismatch`) and with the others
 * against `maxTotalFileSize`, then described for the input: inline (no store listed: the bytes ride
 * in the descriptor, so in the task's own records) or under `<taskId>.<index>` in the store, saved
 * before the task is. A resend of a message whose task waits to start finds its files kept under
 * the same ids — nothing fetched again.
 */

/** One admitted file: the input field it names, if any, and its descriptor. */
export interface AdmittedFile {
  readonly field: string | undefined;
  readonly file: A2AFileDto;
}

/** A message's files for one task id: what the input holds, and what the store is to keep. */
export interface AdmittedFiles {
  readonly files: readonly AdmittedFile[];
  readonly toSave: readonly NewA2AFile[];
}

/** The admission of one message's files, for the task id the accept minted. */
export type FileAdmission = (taskId: string) => Promise<AdmittedFiles>;

const NO_FILES: AdmittedFiles = { files: [], toSave: [] };

/** The id of a task's input file: its place among the message's files. */
export const inputFileIdOf = (taskId: string, index: number): string =>
  `${taskId}.${String(index)}`;

const describedOf = (meta: A2AFileMetadata): A2AFileDto => ({
  mediaType: meta.mediaType,
  ...(meta.filename === undefined ? {} : { filename: meta.filename }),
  fileId: meta.fileId,
  sha256: meta.sha256,
  sizeBytes: meta.sizeBytes,
});

const tooLarge = () =>
  invalidParams("a2a.files-too-large", "the message's files are larger than this agent takes");

/** A request that ended while its file was being fetched: as its own fetch's end would say. */
const leftEarly = () =>
  invalidParams("a2a.file-fetch-failed", "the file could not be fetched in time");

/**
 * Each file's bytes: sent `raw`, or fetched by `url` at most once for the whole admission — and,
 * #904, once for the concurrent duplicates of one message on this listener (`FileFetches`).
 */
function bytesReaderOf(
  parts: A2AServerParts,
  caller: A2ARequestCaller,
  sent: { readonly skill: ServedSkill; readonly messageId: string },
): (file: IncomingFile) => Promise<Uint8Array> {
  const { skill, messageId } = sent;
  const fetched = new Map<number, Promise<Uint8Array>>();
  return (file) => {
    if (file.source.kind === "raw") return Promise.resolve(file.source.bytes);
    const url = file.source.url;
    const { tenantId, ownerId } = caller;
    const key = { tenantId, ownerId, messageId, skill: skill.id, index: file.index, url };
    const fetchOf = (signal: AbortSignal) =>
      fetchedFile({
        url,
        allowedOrigins: skill.fileLimits.allowedFileOrigins,
        maxBytes: skill.fileLimits.maxFileSize,
        transport: parts.files.transport ?? httpsFileTransport,
        clock: parts.clock,
        timeout: parts.files.timeout,
        signal,
      });
    const found =
      fetched.get(file.index) ??
      parts.files.fetches.bytesOf(key, caller.signal, fetchOf, leftEarly);
    fetched.set(file.index, found);
    return found;
  };
}

/** One file's bytes, checked against its declared media type, as its metadata under `fileId`. */
function checkedMetadataOf(
  parts: A2AServerParts,
  each: IncomingFile,
  bytes: Uint8Array,
  owner: { readonly tenantId: string; readonly taskId: string },
): A2AFileMetadata {
  if (!isOfMediaType(each.mediaType, bytes))
    throw invalidParams(
      "a2a.media-type-mismatch",
      "a file's bytes are not of the media type it declares",
    );
  return {
    tenantId: owner.tenantId,
    fileId: inputFileIdOf(owner.taskId, each.index),
    ownerId: owner.taskId,
    mediaType: each.mediaType,
    ...(each.filename === undefined ? {} : { filename: each.filename }),
    sha256: sha256Of(bytes),
    sizeBytes: bytes.byteLength,
    createdAt: parts.clock.now(),
  };
}

/** A file's descriptor with its bytes inline: no store keeps it. */
const inlineOf = (meta: A2AFileMetadata, bytes: Uint8Array): A2AFileDto => ({
  mediaType: meta.mediaType,
  ...(meta.filename === undefined ? {} : { filename: meta.filename }),
  sha256: meta.sha256,
  sizeBytes: meta.sizeBytes,
  inline: Buffer.from(bytes).toString("base64"),
});

/** What one file's admission gives: its place in the input, its size, what the store is to keep. */
interface OneAdmitted {
  readonly admitted: AdmittedFile;
  readonly sizeBytes: number;
  readonly toSave: NewA2AFile | undefined;
}

/** What the files of one message are admitted with. */
interface AdmissionParts {
  readonly parts: A2AServerParts;
  readonly tenantId: string;
  readonly bytesOf: (file: IncomingFile) => Promise<Uint8Array>;
}

/** One file admitted for `taskId`: kept already (a resend), or read, checked and described. */
async function admittedOne(
  admission: AdmissionParts,
  each: IncomingFile,
  taskId: string,
): Promise<OneAdmitted> {
  const { parts, tenantId } = admission;
  const { store } = parts.files;
  const field = each.field;
  if (isInlineFileStore(store)) {
    const bytes = await admission.bytesOf(each);
    const meta = checkedMetadataOf(parts, each, bytes, { tenantId, taskId });
    return {
      admitted: { field, file: inlineOf(meta, bytes) },
      sizeBytes: bytes.byteLength,
      toSave: undefined,
    };
  }
  // a resend of a task that waits to start: its file kept already, nothing fetched again
  const kept = await store.findMetadata({ tenantId, fileId: inputFileIdOf(taskId, each.index) });
  if (kept !== undefined)
    return {
      admitted: { field, file: describedOf(kept) },
      sizeBytes: kept.sizeBytes,
      toSave: undefined,
    };
  const bytes = await admission.bytesOf(each);
  const meta = checkedMetadataOf(parts, each, bytes, { tenantId, taskId });
  return {
    admitted: { field, file: describedOf(meta) },
    sizeBytes: bytes.byteLength,
    toSave: { ...meta, bytes },
  };
}

/** The admission of the files of a message to `skill`, each file's bytes fetched at most once. */
export function fileAdmissionOf(
  parts: A2AServerParts,
  caller: A2ARequestCaller,
  sent: { readonly skill: ServedSkill; readonly messageId: string },
  incoming: readonly IncomingFile[],
): FileAdmission {
  const { skill } = sent;
  if (incoming.length === 0) return () => Promise.resolve(NO_FILES);
  const admission = {
    parts,
    tenantId: caller.tenantId,
    bytesOf: bytesReaderOf(parts, caller, sent),
  };
  return async (taskId) => {
    const files: AdmittedFile[] = [];
    const toSave: NewA2AFile[] = [];
    let total = 0;
    for (const each of incoming) {
      const one = await admittedOne(admission, each, taskId);
      total += one.sizeBytes;
      if (total > skill.fileLimits.maxTotalFileSize) throw tooLarge();
      files.push(one.admitted);
      if (one.toSave !== undefined) toSave.push(one.toSave);
    }
    return { files, toSave };
  };
}
