import { mediaTypeEssenceOf } from "../a2a/files/a2a-file-options.js";
import type { FileDto } from "../dto/standard/file.js";
import type { UsageRecord } from "../finops/usage.js";
import type { Bytes } from "../units/index.js";
import type { PiiTokenMap } from "../pii/tokens.js";
import { fileContentOf, type FileContent, type FileReadContext } from "./file-bytes.js";
import { ModelFileLimitError, fileUnavailable, FileUnavailableReason } from "./file-errors.js";
import { hasModelForm } from "./file-needs.js";
import type { FileMask } from "./file-mask.js";
import { headingOf, sizeOfPiece, type FilePiece, type FilePlace } from "./file-pieces.js";
import { viewOf } from "./file-views.js";
import type { ResolvedModelFiles } from "./file-settings.js";
import type { RedactionPlan, RedactionResult } from "./file-redactor.js";
import type { TranscriptionResult } from "./file-transcriber.js";
import { ModelFileLimit } from "./model-files.js";

/**
 * What a visit's files become in a model message (#899 §2, §3): each source file read once — through
 * the guarded path, its limits checked before any model call — and shown in the agent's views, each under
 * its own heading, the views of one file adjacent.
 */

/** A file of a source, with where it is shown from: JSON, it rides the loop's state. */
export interface SourceFile {
  readonly descriptor: FileDto;
  /** The field it sits in (an input field's name, a tool's name). */
  readonly field: string;
  /** Who gave it: the producer of the input value, or `tool <name>`. */
  readonly producer: string;
  /** A history file that retention removed (#899 §3): shown as its descriptor, `(removed)`. */
  readonly isRemoved?: boolean;
}

/** A source file the model has seen in its visit, with the digest of the bytes it saw: later reads are pinned to it. */
export interface SeenFile {
  readonly source: SourceFile;
  readonly digest: string;
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
  /** Whether the application's redactor makes a redacted copy of this media type (#899 §5). */
  readonly supportsRedaction: (mediaType: string) => boolean;
  /** The redacted copy of a file; the call's spend is the result's `usage`. */
  readonly redact: (file: FileContent, plan: RedactionPlan) => Promise<RedactionResult>;
  /** The root executions of the thread the execution runs in (#899 §3): the owners a history file may have. */
  readonly threadOwners: () => Promise<readonly string[]>;
  /** Names the redactor and its model: part of a redacted copy's cache key. */
  readonly redactorKey: () => string;
}

/** What the loop has of its files so far: how many source files, how many bytes in all views. */
export interface FileTally {
  readonly count: number;
  readonly bytes: number;
}

export const NO_FILES: FileTally = { count: 0, bytes: 0 };

/**
 * One file in one view as a model saw it (#899 §8): what guardrails and judges are given. A
 * transcription is a `text/plain` file of the masked text; an original is the file itself.
 */
export interface ViewedFile {
  readonly content: FileContent;
  /** The heading it had in the message: field, producer, number, view. */
  readonly heading: string;
}

/** What building the pieces of some files gave. */
export interface FilePieces {
  readonly pieces: readonly FilePiece[];
  /** Every file in every view the pieces show, in the same order. */
  readonly viewed: readonly ViewedFile[];
  /** The tokens the masked transcriptions introduced (merged into the execution's `piiTokens`). */
  readonly tokens: PiiTokenMap;
  /** The texts of the pieces already masked: the model boundary skips them. */
  readonly maskedTexts: readonly string[];
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
  /**
   * How the policies mask a transcription (#899 §5, §7); none where nothing is masked. The masked
   * transcription is what is cached: its key names the policies.
   */
  readonly mask?: FileMask | undefined;
  /** The digests the files must have (a later read of files already pinned): another is `digest-mismatch`. */
  readonly pins?: readonly (string | undefined)[];
  /** Called before each model call a transcription makes: the budgets are checked. */
  readonly beforeModelCall: () => void;
}

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
    // a size the descriptor declares (none declared: nothing to check before the read)
    const declared = descriptor.sizeBytes ?? 0;
    if (declared > settings.maxFileSize)
      throw new ModelFileLimitError({
        agent,
        limit: ModelFileLimit.MaxFileSize,
        actual: declared,
        allowed: settings.maxFileSize,
      });
  }
}

/** What building the pieces of a batch has gathered so far. */
interface Gathered {
  readonly pieces: FilePiece[];
  readonly viewed: ViewedFile[];
  readonly usage: UsageRecord[];
  readonly transcripts: Record<string, string>;
  readonly tokens: Record<string, string>;
  readonly digests: string[];
  bytes: number;
}

/** A file's bytes through the guarded path, held to the digest it was pinned to (if it was). */
async function pinnedContentOf(batch: FileBatch, source: SourceFile, index: number) {
  const content = await fileContentOf(source.descriptor, batch.runtime.context());
  const pin = batch.pins?.[index];
  if (pin !== undefined && pin !== content.sha256)
    throw fileUnavailable({ reason: FileUnavailableReason.DigestMismatch });
  return content;
}

/** One file in every view of the agent's: gathered, its bytes counted against the total limit. */
async function gatherViews(
  batch: FileBatch,
  content: FileContent,
  place: FilePlace,
  gathered: Gathered,
): Promise<void> {
  const { runtime } = batch;
  const { settings, agent } = runtime;
  for (const view of settings.views) {
    const heading = headingOf(place, content, view);
    const known = { ...batch.mask?.known, ...gathered.tokens };
    const shown = await viewOf(batch, content, view, heading, known);
    gathered.bytes += shown.pieces.reduce((sum, piece) => sum + sizeOfPiece(piece), 0);
    if (gathered.bytes > settings.maxTotalFileSize)
      throw new ModelFileLimitError({
        agent,
        limit: ModelFileLimit.MaxTotalFileSize,
        actual: gathered.bytes,
        allowed: settings.maxTotalFileSize,
      });
    gathered.pieces.push(...shown.pieces);
    gathered.viewed.push({ content: shown.viewed, heading });
    gathered.usage.push(...shown.usage);
    Object.assign(gathered.tokens, shown.tokens);
    if (shown.made !== undefined) gathered.transcripts[shown.made.key] = shown.made.entry;
  }
}

/** A history file that is no longer kept: its descriptor under its heading, `(removed)`. */
function removedPiece(batch: FileBatch, source: SourceFile, index: number): FilePiece {
  const { descriptor } = source;
  const named = descriptor.filename ?? descriptor.fileId ?? descriptor.url ?? "file";
  const where =
    batch.of === undefined
      ? String(batch.first + index)
      : `${String(batch.first + index)} of ${String(batch.of)}`;
  return {
    kind: "text",
    text: `### ${source.field} (from ${source.producer}, file ${where}: ${named}, ${descriptor.mediaType}) (removed)`,
  };
}

/** The pieces of a batch of files, in order; over a limit → `ModelFileLimitError`, before any model call. */
export async function filePiecesOf(batch: FileBatch): Promise<FilePieces> {
  checkedDeclared(batch);
  const gathered: Gathered = {
    pieces: [],
    viewed: [],
    usage: [],
    transcripts: {},
    tokens: {},
    digests: [],
    bytes: batch.tally.bytes,
  };
  for (const [index, source] of batch.files.entries()) {
    if (source.isRemoved === true) {
      gathered.digests.push("");
      gathered.pieces.push(removedPiece(batch, source, index));
      continue;
    }
    const content = await pinnedContentOf(batch, source, index);
    gathered.digests.push(content.sha256);
    const place = {
      field: source.field,
      producer: source.producer,
      number: batch.first + index,
      of: batch.of,
    };
    await gatherViews(batch, content, place, gathered);
  }
  const { pieces, bytes, ...rest } = gathered;
  return {
    ...rest,
    pieces,
    maskedTexts: pieces.flatMap((piece) => {
      switch (piece.kind) {
        case "text":
          return piece.isMasked === true ? [piece.text] : [];
        default:
          return [];
      }
    }),
    tally: { count: batch.tally.count + batch.files.length, bytes },
  };
}
