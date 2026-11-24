import { bytes as byteSize } from "../../units/index.js";
import { createHash } from "node:crypto";
import { currentFrame, rootFactsOf, type ExecutionFacts } from "../../flow/context/frame.js";
import { isInlineFileStore, type FileRepository } from "../../infrastructure/file.repository.js";
import { definedOf, type Clock } from "../../infrastructure/clock.js";
import { contextMeshSettingsOf } from "../../mesh/mesh-settings.js";
import { FilePayloadSource, fileSourceOf, type FileDto } from "../../dto/standard/file.js";
import {
  FileRefusal,
  fileRefused,
  fileUnavailable,
  FileUnavailableReason,
} from "../../files/file-errors.js";
import { fileLimitsOf, mediaTypeEssenceOf } from "./a2a-file-options.js";
import type { FileToSave } from "./files.service.js";
import { isOfMediaType } from "./a2a-media-check.js";

/**
 * What `Files` does (#859), loaded with its first save or read: the root import keeps only the
 * service's class.
 */

const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** The execution a step runs in; `undefined` outside one. */
const executionOf = (): ExecutionFacts | undefined => currentFrame()?.execution;

/** A save's content checked against the application's limits; its media type's essence. */
function checkedMediaTypeOf(execution: ExecutionFacts, content: FileToSave): string {
  const mediaType = mediaTypeEssenceOf(content.mediaType);
  const sizeBytes = content.bytes.byteLength;
  const settings = contextMeshSettingsOf(execution.tenant.application);
  const limits = fileLimitsOf(settings?.a2aFiles, undefined);
  if (!limits.allowedMediaTypes.includes(mediaType))
    throw fileRefused({ refusal: FileRefusal.MediaType, mediaType });
  if (sizeBytes > limits.maxFileSize)
    throw fileRefused({ refusal: FileRefusal.TooLarge, sizeBytes });
  if (!isOfMediaType(mediaType, content.bytes))
    throw fileRefused({ refusal: FileRefusal.MediaTypeMismatch, mediaType });
  return mediaType;
}

/** `Files.save`: kept for the execution's task (inline with no store); its descriptor. */
export async function savedFile(
  store: FileRepository,
  clock: Pick<Clock, "now">,
  content: FileToSave,
): Promise<FileDto> {
  const execution = executionOf();
  if (execution === undefined) throw fileRefused({ refusal: FileRefusal.OutsideExecution });
  const mediaType = checkedMediaTypeOf(execution, content);
  const sha256 = sha256Of(content.bytes);
  const named = content.filename === undefined ? {} : { filename: content.filename };
  const described = { mediaType, ...named, sha256, sizeBytes: content.bytes.byteLength };
  if (isInlineFileStore(store))
    return { ...described, inline: Buffer.from(content.bytes).toString("base64") };
  const ownerId = rootFactsOf(execution).executionId;
  // by its bytes: a step run again saves the same file under the same id
  const fileId = `${ownerId}.${sha256}`;
  await store.save({
    tenantId: execution.tenant.tenantId,
    fileId,
    ownerId,
    ...described,
    sizeBytes: byteSize(described.sizeBytes),
    createdAt: clock.now(),
    bytes: Uint8Array.from(content.bytes),
  });
  return { ...described, fileId };
}

/** A file's bytes as its descriptor says where they are, for this execution's task. */
async function bytesOf(
  store: FileRepository,
  file: FileDto,
  execution: ExecutionFacts,
): Promise<Uint8Array> {
  switch (fileSourceOf(file)) {
    case FilePayloadSource.Url:
      throw fileUnavailable({ reason: FileUnavailableReason.ByReference });
    case FilePayloadSource.Inline:
      return new Uint8Array(
        Buffer.from(
          definedOf(
            file.inline,
            // Stryker disable next-line StringLiteral: equivalent: the text of an invariant that holds is never read
            "an inline file has its bytes",
          ),
          "base64",
        ),
      );
    case FilePayloadSource.Stored: {
      const key = {
        tenantId: execution.tenant.tenantId,
        // Stryker disable next-line StringLiteral: equivalent: the text of an invariant that holds is never read
        fileId: definedOf(file.fileId, "a stored file has its id"),
      };
      const meta = await store.findMetadata(key);
      const bytes =
        meta?.ownerId === rootFactsOf(execution).executionId
          ? await store.findBytes(key)
          : undefined;
      if (bytes === undefined) throw fileUnavailable({ reason: FileUnavailableReason.NotFound });
      return bytes;
    }
  }
}

/** `Files.read`: the bytes of a file of this execution's task, checked against its digest. */
export async function readFile(store: FileRepository, file: FileDto): Promise<Uint8Array> {
  const execution = executionOf();
  if (execution === undefined)
    throw fileUnavailable({ reason: FileUnavailableReason.OutsideExecution });
  const bytes = await bytesOf(store, file, execution);
  if (sha256Of(bytes) !== file.sha256)
    throw fileUnavailable({ reason: FileUnavailableReason.DigestMismatch });
  return bytes;
}
