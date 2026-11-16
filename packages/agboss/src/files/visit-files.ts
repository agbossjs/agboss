import { mediaTypeEssenceOf } from "../a2a/files/a2a-file-options.js";
import type { A2AFileDto } from "../a2a/files/a2a-file.dto.js";
import type { UsageRecord } from "../finops/usage.js";
import type { Bytes } from "../units/index.js";
import { fileContentOf, type FileContent, type FileReadContext } from "./file-bytes.js";
import {
  ModelFileLimitError,
  ModelFileUnavailableError,
  ModelFileUnavailableReason,
} from "./file-errors.js";
import { hasModelForm } from "./file-needs.js";
import {
  headingOf,
  originalPieces,
  ownTranscriptOf,
  sizeOfPiece,
  textPiece,
  type FilePiece,
} from "./file-pieces.js";
import type { ResolvedModelFiles } from "./file-settings.js";
import type { TranscriptionResult } from "./file-transcriber.js";
import { FileView, ModelFileLimit } from "./model-files.js";

/**
 * What a visit's files become in a model message (#899 §2, §3): each source file read once — through
 * the guarded path, its limits checked before any model call — and shown in the agent's views, each under
 * its own heading, the views of one file adjacent.
 */

/** A file of a source, with where it is shown from: JSON, it rides the loop's state. */
export interface SourceFile {
  readonly descriptor: A2AFileDto;
  /** The field it sits in (an input field's name, a tool's name). */
  readonly field: string;
  /** Who gave it: the producer of the input value, or `tool <name>`. */
  readonly producer: string;
}

/** What the loop reads files with: its settings and where its bytes and transcriptions come from. */
export interface FileRuntime {
  readonly agent: string;
  readonly settings: ResolvedModelFiles;
  readonly maxResultSize: Bytes;
  readonly context: () => FileReadContext;
  /** The transcription of a file; the call's spend is the result's `usage`. */
  readonly transcribe: (file: FileContent) => Promise<TranscriptionResult>;
  /** Names the transcriber and its model: part of a transcription's cache key. */
  readonly transcriberKey: () => string;
}

/** What the loop has of its files so far: how many source files, how many bytes in all views. */
export interface FileTally {
  readonly count: number;
  readonly bytes: number;
}

export const NO_FILES: FileTally = { count: 0, bytes: 0 };

/** What building the pieces of some files gave. */
export interface FilePieces {
  readonly pieces: readonly FilePiece[];
  readonly usage: readonly UsageRecord[];
  /** The sha256 of each source file's bytes, in order: what a later read of the same files is pinned to. */
  readonly digests: readonly string[];
  /** The transcriptions made, by cache key. */
  readonly transcripts: Readonly<Record<string, string>>;
  readonly tally: FileTally;
}

/** What a batch of files is built with. */
export interface FileBatch {
  readonly runtime: FileRuntime;
  readonly files: readonly SourceFile[];
  /** What the conversation already holds. */
  readonly tally: FileTally;
  /** Transcriptions already made in this execution. */
  readonly cache: Readonly<Record<string, string>>;
  /** The number of the batch's first file in its visit; `of`: how many files the visit has, when known. */
  readonly first: number;
  readonly of?: number;
  /** The digests the files must have (a later read of files already pinned): another is `digest-mismatch`. */
  readonly pins?: readonly string[];
  /** Called before each model call a transcription makes: the budgets are checked. */
  readonly beforeModelCall: () => void;
}

/** Where a transcription is cached: per file's bytes and per transcriber, model and bound (#899 §7). */
export const transcriptKeyOf = (runtime: FileRuntime, content: FileContent): string =>
  `${content.sha256}:${runtime.transcriberKey()}:${String(runtime.settings.transcriptionMaxTokens)}`;

/** The batch's counts and each file's declared type and size against the agent's limits, before any read. */
function checkedDeclared(batch: FileBatch): void {
  const { settings, agent } = batch.runtime;
  const count = batch.tally.count + batch.files.length;
  if (count > settings.maxFiles)
    throw new ModelFileLimitError({
      agent,
      limit: ModelFileLimit.MaxFiles,
      actual: count,
      allowed: settings.maxFiles,
    });
  for (const { descriptor } of batch.files) {
    const mediaType = mediaTypeEssenceOf(descriptor.mediaType);
    if (!settings.allowedMediaTypes.includes(mediaType) || !hasModelForm(mediaType))
      throw new ModelFileLimitError({
        agent,
        limit: ModelFileLimit.MediaType,
        actual: mediaType,
        allowed: settings.allowedMediaTypes.join(", "),
      });
    if (descriptor.sizeBytes !== undefined && descriptor.sizeBytes > settings.maxFileSize)
      throw new ModelFileLimitError({
        agent,
        limit: ModelFileLimit.MaxFileSize,
        actual: descriptor.sizeBytes,
        allowed: settings.maxFileSize,
      });
  }
}

/** One file in one view: its pieces, and — for a transcription — the text and what it cost. */
async function viewOf(
  batch: FileBatch,
  content: FileContent,
  view: FileView,
  heading: string,
): Promise<{ pieces: readonly FilePiece[]; made?: string; usage: readonly UsageRecord[] }> {
  const { runtime } = batch;
  if (view !== FileView.Transcription)
    return { pieces: originalPieces(heading, content, runtime.maxResultSize), usage: [] };
  const own = ownTranscriptOf(content);
  const key = transcriptKeyOf(runtime, content);
  const cached = own ?? batch.cache[key];
  if (cached !== undefined)
    return { pieces: [textPiece(heading, cached, runtime.maxResultSize)], usage: [] };
  batch.beforeModelCall();
  const result = await runtime.transcribe(content);
  return {
    pieces: [textPiece(heading, result.text, runtime.maxResultSize)],
    made: result.text,
    usage: result.usage === undefined ? [] : [result.usage],
  };
}

/** The pieces of a batch of files, in order; over a limit → `ModelFileLimitError`, before any model call. */
export async function filePiecesOf(batch: FileBatch): Promise<FilePieces> {
  checkedDeclared(batch);
  const { runtime } = batch;
  const { settings, agent } = runtime;
  const pieces: FilePiece[] = [];
  const usage: UsageRecord[] = [];
  const transcripts: Record<string, string> = {};
  const digests: string[] = [];
  let bytes = batch.tally.bytes;
  for (const [index, source] of batch.files.entries()) {
    const content = await fileContentOf(source.descriptor, runtime.context());
    const pin = batch.pins?.[index];
    if (pin !== undefined && pin !== content.sha256)
      throw new ModelFileUnavailableError({ reason: ModelFileUnavailableReason.DigestMismatch });
    digests.push(content.sha256);
    const place = {
      field: source.field,
      producer: source.producer,
      number: batch.first + index,
      of: batch.of,
    };
    for (const view of settings.views) {
      const shown = await viewOf(batch, content, view, headingOf(place, content, view));
      bytes += shown.pieces.reduce((sum, piece) => sum + sizeOfPiece(piece), 0);
      if (bytes > settings.maxTotalFileSize)
        throw new ModelFileLimitError({
          agent,
          limit: ModelFileLimit.MaxTotalFileSize,
          actual: bytes,
          allowed: settings.maxTotalFileSize,
        });
      pieces.push(...shown.pieces);
      usage.push(...shown.usage);
      if (shown.made !== undefined) transcripts[transcriptKeyOf(runtime, content)] = shown.made;
    }
  }
  return {
    pieces,
    usage,
    digests,
    transcripts,
    tally: { count: batch.tally.count + batch.files.length, bytes },
  };
}
