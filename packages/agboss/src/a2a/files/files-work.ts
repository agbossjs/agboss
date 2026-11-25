import { bytes as byteSize, Ttl, type Milliseconds } from "../../units/index.js";
import { ttlMillisOf } from "../../files/file-ttl.js";
import { createHash } from "node:crypto";
import { currentFrame, rootFactsOf, type ExecutionFacts } from "../../flow/context/frame.js";
import { isInlineFileStore, type FileRepository } from "../../infrastructure/file.repository.js";
import { definedOf, lazyLoad, type Clock } from "../../infrastructure/clock.js";
import { appFileSlotsOf } from "./a2a-file-pool.js";
import { callerKeyOf, tenantKeyOf } from "./a2a-file-slots.js";
import { MAX_INLINE_FILE_BYTES } from "../../files/inline-cap.js";
import type { ComponentOptions } from "../../components/component-options.js";
import { FilePayloadSource, fileSourceOf, type FileDto } from "../../dto/standard/file.js";
import {
  FileRefusal,
  fileRefused,
  fileUnavailable,
  FileUnavailableReason,
} from "../../files/file-errors.js";
import { mediaTypeEssenceOf } from "./a2a-file-options.js";
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
function checkedMediaTypeOf(
  execution: ExecutionFacts,
  content: FileToSave,
  options: ComponentOptions,
): string {
  const mediaType = mediaTypeEssenceOf(content.mediaType);
  const sizeBytes = content.bytes.byteLength;
  // the limits of the execution's workflow `@FilePolicy` (#1316), the built-ins without one
  const limits = options.workflowFileLimits(execution.workflow.type);
  if (!limits.allowedMediaTypes.includes(mediaType))
    throw fileRefused({ refusal: FileRefusal.MediaType, mediaType });
  if (sizeBytes > limits.maxFileSize)
    throw fileRefused({ refusal: FileRefusal.TooLarge, sizeBytes });
  if (!isOfMediaType(mediaType, content.bytes))
    throw fileRefused({ refusal: FileRefusal.MediaTypeMismatch, mediaType });
  return mediaType;
}

/**
 * How long a saved file is kept once its tree has ended (#1316): its own `ttl`, never longer than its
 * workflow's `@FilePolicy.ttl`; else that one. `undefined` for ever (a policy of `Ttl.Forever`, no own `ttl`).
 */
function savedTtlOf(
  execution: ExecutionFacts,
  content: FileToSave,
  options: ComponentOptions,
): Milliseconds | undefined {
  const policy = options.workflowFileLimits(execution.workflow.type).ttl;
  if (content.ttl === undefined) return policy === Ttl.Forever ? undefined : policy;
  if (!Number.isInteger(content.ttl) || content.ttl < 1 || content.ttl > ttlMillisOf(policy))
    throw fileRefused({ refusal: FileRefusal.TtlAbovePolicy });
  return content.ttl;
}

/** `Files.save`: kept for the execution's task (inline with no store); its descriptor. */
export async function savedFile(
  store: FileRepository,
  clock: Pick<Clock, "now">,
  content: FileToSave,
  options: ComponentOptions,
): Promise<FileDto> {
  const execution = executionOf();
  if (execution === undefined) throw fileRefused({ refusal: FileRefusal.OutsideExecution });
  const mediaType = checkedMediaTypeOf(execution, content, options);
  const sha256 = sha256Of(content.bytes);
  const ttl = savedTtlOf(execution, content, options);
  const named = content.filename === undefined ? {} : { filename: content.filename };
  const described = { mediaType, ...named, sha256, sizeBytes: content.bytes.byteLength };
  if (isInlineFileStore(store)) {
    // no store: the bytes ride in the descriptor, so only up to the inline cap (#1316)
    if (content.bytes.byteLength > MAX_INLINE_FILE_BYTES)
      throw fileRefused({
        refusal: FileRefusal.InlineTooLarge,
        sizeBytes: content.bytes.byteLength,
      });
    return { ...described, inline: Buffer.from(content.bytes).toString("base64") };
  }
  const ownerId = rootFactsOf(execution).executionId;
  // by its bytes: a step run again saves the same file under the same id
  const fileId = `${ownerId}.${sha256}`;
  await store.save({
    tenantId: execution.tenant.tenantId,
    fileId,
    ownerId,
    ...described,
    ...(ttl === undefined ? {} : { ttl }),
    sizeBytes: byteSize(described.sizeBytes),
    createdAt: clock.now(),
    bytes: Uint8Array.from(content.bytes),
  });
  return { ...described, fileId };
}

/** A file's bytes as its descriptor says where they are, for this execution's task. */
async function bytesOf(
  store: FileRepository,
  clock: Pick<Clock, "now" | "sleep">,
  file: FileDto,
  execution: ExecutionFacts,
  options: ComponentOptions,
): Promise<Uint8Array> {
  switch (fileSourceOf(file)) {
    case FilePayloadSource.Url:
      return fetchedBytes(store, clock, file, execution, options);
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

/**
 * A file by url, fetched as the workflow's `@FilePolicy` says (#1316): its `allowedOrigins`, its
 * `maxFileSize`, its `fetchTimeout`, in its `fetchPool` (else the application's shared one) —
 * the same guarded path a model's read of a file by url takes.
 */
async function fetchedBytes(
  store: FileRepository,
  clock: Pick<Clock, "now" | "sleep">,
  file: FileDto,
  execution: ExecutionFacts,
  options: ComponentOptions,
): Promise<Uint8Array> {
  const limits = options.workflowFileLimits(execution.workflow.type);
  const { httpsFileTransport } = await lazyLoad(import("./a2a-file-transport.js"));
  const { fileContentOf } = await lazyLoad(import("../../files/file-bytes.js"));
  const { tenantId } = execution.tenant;
  const content = await fileContentOf(file, {
    store,
    tenantId,
    ownerId: rootFactsOf(execution).executionId,
    signal: execution.signal,
    clock,
    transport: httpsFileTransport,
    allowedOrigins: limits.allowedOrigins,
    fetchTimeout: limits.fetchTimeout,
    maxFileSize: limits.maxFileSize,
    slots: appFileSlotsOf(store, limits.fetchPool),
    caller: { tenant: tenantKeyOf(tenantId), owner: callerKeyOf(tenantId, execution.ownerId) },
  });
  return content.bytes;
}

/** `Files.read`: the bytes of a file of this execution's task, checked against its digest. */
export async function readFile(
  store: FileRepository,
  clock: Pick<Clock, "now" | "sleep">,
  file: FileDto,
  options: ComponentOptions,
): Promise<Uint8Array> {
  const execution = executionOf();
  if (execution === undefined)
    throw fileUnavailable({ reason: FileUnavailableReason.OutsideExecution });
  // a stored or inline file is checked against its digest, so one with none is refused; only a
  // file by url, whose bytes the origin owns, may come without one
  if (file.sha256 === undefined && fileSourceOf(file) !== FilePayloadSource.Url)
    throw fileUnavailable({ reason: FileUnavailableReason.DigestMissing });
  const bytes = await bytesOf(store, clock, file, execution, options);
  if (file.sha256 !== undefined && sha256Of(bytes) !== file.sha256)
    throw fileUnavailable({ reason: FileUnavailableReason.DigestMismatch });
  return bytes;
}
