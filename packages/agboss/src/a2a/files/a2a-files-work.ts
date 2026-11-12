import { createHash } from "node:crypto";
import { currentFrame, rootFactsOf, type ExecutionFacts } from "../../flow/context/frame.js";
import {
  isInlineFileStore,
  type A2AFileRepository,
} from "../../infrastructure/a2a-file.repository.js";
import type { Clock } from "../../infrastructure/clock.js";
import { contextMeshSettingsOf } from "../../mesh/mesh-settings.js";
import { A2AFileSource, fileSourceOf, type A2AFileDto } from "./a2a-file.dto.js";
import {
  A2AFileRefusal,
  A2AFileRefusedError,
  A2AFileUnavailableError,
  A2AFileUnavailableReason,
} from "./a2a-file-errors.js";
import { fileLimitsOf, mediaTypeEssenceOf } from "./a2a-file-options.js";
import type { A2AFileContent } from "./a2a-files.service.js";
import { isOfMediaType } from "./a2a-media-check.js";

/**
 * What `A2AFiles` does (#859), loaded with its first save or read: the root import keeps only the
 * service's class.
 */

const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** The execution a step runs in; `undefined` outside one. */
const executionOf = (): ExecutionFacts | undefined => currentFrame()?.execution;

/** A save's content checked against the application's limits; its media type's essence. */
function checkedMediaTypeOf(execution: ExecutionFacts, content: A2AFileContent): string {
  const mediaType = mediaTypeEssenceOf(content.mediaType);
  const sizeBytes = content.bytes.byteLength;
  const settings = contextMeshSettingsOf(execution.tenant.application);
  const limits = fileLimitsOf(settings?.a2aFiles, undefined);
  if (!limits.allowedMediaTypes.includes(mediaType))
    throw new A2AFileRefusedError({ refusal: A2AFileRefusal.MediaType, mediaType });
  if (sizeBytes > limits.maxFileSize)
    throw new A2AFileRefusedError({ refusal: A2AFileRefusal.TooLarge, sizeBytes });
  if (!isOfMediaType(mediaType, content.bytes))
    throw new A2AFileRefusedError({ refusal: A2AFileRefusal.MediaTypeMismatch, mediaType });
  return mediaType;
}

/** `A2AFiles.save`: kept for the execution's task (inline with no store); its descriptor. */
export async function savedFile(
  store: A2AFileRepository,
  clock: Pick<Clock, "now">,
  content: A2AFileContent,
): Promise<A2AFileDto> {
  const execution = executionOf();
  if (execution === undefined)
    throw new A2AFileRefusedError({ refusal: A2AFileRefusal.OutsideExecution });
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
    createdAt: clock.now(),
    bytes: Uint8Array.from(content.bytes),
  });
  return { ...described, fileId };
}

/** A file's bytes as its descriptor says where they are, for this execution's task. */
async function bytesOf(
  store: A2AFileRepository,
  file: A2AFileDto,
  execution: ExecutionFacts,
): Promise<Uint8Array> {
  switch (fileSourceOf(file)) {
    case A2AFileSource.Url:
      throw new A2AFileUnavailableError({ reason: A2AFileUnavailableReason.ByReference });
    case A2AFileSource.Inline:
      return new Uint8Array(Buffer.from(file.inline ?? "", "base64"));
    case A2AFileSource.Stored: {
      const key = { tenantId: execution.tenant.tenantId, fileId: file.fileId ?? "" };
      const meta = await store.findMetadata(key);
      const bytes =
        meta?.ownerId === rootFactsOf(execution).executionId
          ? await store.findBytes(key)
          : undefined;
      if (bytes === undefined)
        throw new A2AFileUnavailableError({ reason: A2AFileUnavailableReason.NotFound });
      return bytes;
    }
  }
}

/** `A2AFiles.read`: the bytes of a file of this execution's task, checked against its digest. */
export async function readFile(store: A2AFileRepository, file: A2AFileDto): Promise<Uint8Array> {
  const execution = executionOf();
  if (execution === undefined)
    throw new A2AFileUnavailableError({ reason: A2AFileUnavailableReason.OutsideExecution });
  const bytes = await bytesOf(store, file, execution);
  if (sha256Of(bytes) !== file.sha256)
    throw new A2AFileUnavailableError({ reason: A2AFileUnavailableReason.DigestMismatch });
  return bytes;
}
