import { createHash } from "node:crypto";
import { isOfMediaType } from "../a2a/files/a2a-media-check.js";
import type { UsageRecord } from "../finops/usage.js";
import { InlineA2AFileRepository } from "../infrastructure/a2a-file.repository.js";
import { PiiKind } from "../pii/kinds.js";
import { fileContentOf, sha256Of, type FileContent } from "./file-bytes.js";
import { FileRedactionFailedError } from "./file-errors.js";
import { originalPieces } from "./file-pieces.js";
import type { FileMask } from "./file-mask.js";
import { valuesForRedactor } from "./redaction-values.js";
import type { FileBatch } from "./visit-files.js";

/**
 * A file in the redacted view (#899 §5, §7): a copy with every personal datum the agent's policies name
 * blacked out, made once per execution. Never the unredacted file in its place: a redactor that fails,
 * an answer that is not a file of the same type, a type no redactor takes, a copy that cannot be kept —
 * each is `FileRedactionFailedError`; a block rule's kind found in the file is the policy's refusal.
 */

/** The most bytes of a redacted copy kept in the execution's state when there is no file store (#899 §7). */
export const MAX_INLINE_REDACTED = 64 * 1024;

/** What is kept of a redacted copy: in the state (inline) or in the file store (by id). */
interface KeptRedacted {
  readonly mediaType: string;
  readonly filename?: string;
  readonly sha256: string;
  readonly inline?: string;
  readonly fileId?: string;
}

/**
 * Where a redacted copy is cached: the bytes, the redactor, the model, the policies that decided what to hide
 * and the exact values the redactor was told to find — a keyed digest of the sorted set (never a plain
 * hash), or a fixed marker when only kinds are sent: a copy made for one set of values is never another's.
 * The cache is in one execution's state, so never across tenants or executions.
 */
export const redactedKeyOf = (batch: FileBatch, content: FileContent, mask: FileMask): string => {
  const sent = valuesForRedactor(batch.runtime.settings, mask.redaction.values);
  const values = sent.length === 0 ? "kinds-only" : `values:${mask.keyedDigestOf(sent)}`;
  return `redacted:${content.sha256}:${batch.runtime.redactorKey()}:${String(batch.runtime.settings.transcriptionMaxTokens)}:${mask.policyHash}:${values}`;
};

const parsed = (kept: string): KeptRedacted => JSON.parse(kept) as KeptRedacted;

/** The copy a cache entry names, read again (from the store through the guarded path, or from the state). */
async function keptContentOf(batch: FileBatch, kept: KeptRedacted): Promise<FileContent> {
  if (kept.inline !== undefined) {
    const bytes = new Uint8Array(Buffer.from(kept.inline, "base64"));
    return {
      mediaType: kept.mediaType,
      ...(kept.filename === undefined ? {} : { filename: kept.filename }),
      bytes,
      sha256: sha256Of(bytes),
    };
  }
  return fileContentOf(
    {
      mediaType: kept.mediaType,
      fileId: kept.fileId ?? "",
      sha256: kept.sha256,
      ...(kept.filename === undefined ? {} : { filename: kept.filename }),
    },
    batch.runtime.context(),
  );
}

/** Keeps a copy: in the file store, owned by the root execution, or inline up to 64 KB. */
async function keptOf(batch: FileBatch, copy: FileContent): Promise<KeptRedacted> {
  const context = batch.runtime.context();
  const base = {
    mediaType: copy.mediaType,
    sha256: copy.sha256,
    ...(copy.filename === undefined ? {} : { filename: copy.filename }),
  };
  if (context.store instanceof InlineA2AFileRepository) {
    if (copy.bytes.byteLength > MAX_INLINE_REDACTED)
      throw new FileRedactionFailedError({
        agent: batch.runtime.agent,
        reason: `the redacted copy is ${String(copy.bytes.byteLength)} bytes, over the ${String(MAX_INLINE_REDACTED)} an execution keeps without a file store`,
      });
    return { ...base, inline: Buffer.from(copy.bytes).toString("base64") };
  }
  const fileId = `redacted-${createHash("sha256").update(`${context.ownerId}:${copy.sha256}`).digest("hex").slice(0, 40)}`;
  await context.store.save({
    tenantId: context.tenantId,
    fileId,
    ownerId: context.ownerId,
    mediaType: copy.mediaType,
    sha256: copy.sha256,
    sizeBytes: copy.bytes.byteLength,
    createdAt: context.clock.now(),
    ...(copy.filename === undefined ? {} : { filename: copy.filename }),
    bytes: copy.bytes,
  });
  return { ...base, fileId };
}

/** What the redacted view of one file gave: its pieces, the copy, and what making it cost. */
export interface RedactedView {
  readonly pieces: ReturnType<typeof originalPieces>;
  readonly viewed: FileContent;
  /** The entry newly made for the cache, and the key it is kept under. */
  readonly made?: string;
  readonly cacheKey?: string;
  readonly usage: readonly UsageRecord[];
}

/** The copy checked: a file of the media type the redactor said it takes, of the bytes that type has. */
function checkedCopy(batch: FileBatch, original: FileContent, copy: FileContent): FileContent {
  const fail = (reason: string) =>
    new FileRedactionFailedError({ agent: batch.runtime.agent, reason });
  if (copy.mediaType !== original.mediaType && !batch.runtime.supportsRedaction(copy.mediaType))
    throw fail("the redactor answered a file of another media type");
  if (copy.bytes.byteLength === 0 || !isOfMediaType(copy.mediaType, copy.bytes))
    throw fail("the redactor's file is not what its media type says");
  if (copy.bytes.byteLength > batch.runtime.settings.maxFileSize)
    throw fail("the redacted copy is over maxFileSize");
  return { ...copy, sha256: sha256Of(copy.bytes) };
}

/**
 * What a redactor is asked for, after what must stop the file before any model is asked: a block rule's kind
 * where no model's judgement is accepted (a guardrail, not a guarantee, #899 §5), values that cannot be sent
 * and nothing at all to look for — never a re-encode passed off as redacted.
 */
async function askedOf(batch: FileBatch, mask: FileMask) {
  const { kinds, values, blocked, isModelChecked } = mask.redaction;
  const agent = batch.runtime.agent;
  const [firstBlocked] = blocked;
  if (firstBlocked !== undefined && !isModelChecked) {
    const refusal = await mask.refusalForKind(firstBlocked);
    if (refusal !== undefined) throw refusal;
  }
  const sent = valuesForRedactor(batch.runtime.settings, values);
  if (values.length > 0 && sent.length === 0)
    throw new FileRedactionFailedError({
      agent,
      reason:
        "the execution has values to redact that the redactor may not be told (defaults.files.redactionValues)",
    });
  if (kinds.length === 0 && sent.length === 0)
    throw new FileRedactionFailedError({
      agent,
      reason: "the policies name no kind and no value for the redactor to look for",
    });
  return { targets: kinds, values: sent };
}

/** One file in the redacted view; nothing to hide (no policy, no sensitive value) is the file itself. */
export async function redactedViewOf(
  batch: FileBatch,
  content: FileContent,
  heading: string,
): Promise<RedactedView> {
  const { runtime, mask } = batch;
  const shown = (
    file: FileContent,
    made?: { readonly entry: string; readonly key: string },
    usage: readonly UsageRecord[] = [],
  ) => ({
    pieces: originalPieces(heading, file, runtime.maxResultSize),
    viewed: file,
    ...(made === undefined ? {} : { made: made.entry, cacheKey: made.key }),
    usage,
  });
  if (mask === undefined) return shown(content);
  if (!runtime.supportsRedaction(content.mediaType))
    throw new FileRedactionFailedError({
      agent: runtime.agent,
      reason: `no redactor takes ${content.mediaType}`,
    });
  const key = redactedKeyOf(batch, content, mask);
  const cached = batch.cache[key];
  if (cached !== undefined) return shown(await keptContentOf(batch, parsed(cached)));
  const asked = await askedOf(batch, mask);
  batch.beforeModelCall();
  const result = await runtime.redact(content, asked);
  const spent = result.usage === undefined ? [] : [result.usage];
  for (const target of result.found) {
    const refusal = await mask.refusalForKind(target as PiiKind);
    if (refusal !== undefined) throw refusal;
  }
  const copy = checkedCopy(batch, content, result.file);
  const kept = await keptOf(batch, copy).catch((error: unknown) => {
    if (error instanceof FileRedactionFailedError) throw error;
    throw new FileRedactionFailedError({
      agent: runtime.agent,
      reason: "the redacted copy cannot be kept",
      cause: error,
    });
  });
  return shown(copy, { entry: JSON.stringify(kept), key }, spent);
}
