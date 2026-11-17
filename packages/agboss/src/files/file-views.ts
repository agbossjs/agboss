import type { UsageRecord } from "../finops/usage.js";
import type { PiiTokenMap } from "../pii/tokens.js";
import { sha256Of, type FileContent } from "./file-bytes.js";
import {
  maskedTextPieces,
  originalPieces,
  ownTranscriptOf,
  textPiece,
  type FilePiece,
  type MadeEntry,
} from "./file-pieces.js";
import { isTextFormat } from "./file-needs.js";
import { FileView } from "./model-files.js";
import { redactedViewOf } from "./redacted-view.js";
import type { FileBatch, FileRuntime } from "./visit-files.js";

/**
 * One file in one view (#899 §2, §5, §7): the original as its pieces, a transcription — from the
 * execution's cache, a text format's own text or the transcriber's — masked by the agent's policies
 * where they apply, the masked text being what is kept.
 */

/**
 * Where a transcription is cached: per file's bytes, per transcriber, model and bound, and per set of
 * policies that masked it (#899 §7). The cache lives in one execution's state — never across tenants.
 */
export const transcriptKeyOf = (
  runtime: FileRuntime,
  content: FileContent,
  policyHash: string,
): string =>
  `${content.sha256}:${runtime.transcriberKey()}:${String(runtime.settings.transcriptionMaxTokens)}:${policyHash}`;

/** What one file in one view gave. */
interface ViewResult {
  readonly pieces: readonly FilePiece[];
  readonly viewed: FileContent;
  /** What was newly made for the cache (a masked text, a redacted copy), and the key it is kept under. */
  readonly made?: MadeEntry;
  readonly tokens: PiiTokenMap;
  readonly usage: readonly UsageRecord[];
}

/** A transcription as a file: the masked text, `text/plain`. */
function transcriptFile(content: FileContent, text: string): FileContent {
  const bytes = Buffer.from(text); // UTF-8, the default
  return {
    mediaType: "text/plain",
    ...(content.filename === undefined ? {} : { filename: content.filename }),
    bytes,
    sha256: sha256Of(bytes),
  };
}

/**
 * One file in the transcription view: from the execution's cache, a text format's own text, or the
 * transcriber's. Where policies apply the text is masked first — a block rule refuses — and the masked
 * text is what is kept; the tokens it made go to the execution.
 */
async function transcriptionOf(
  batch: FileBatch,
  content: FileContent,
  heading: string,
  known: PiiTokenMap,
): Promise<ViewResult> {
  const { runtime, mask } = batch;
  const key = transcriptKeyOf(runtime, content, mask?.policyHash ?? "");
  const cached = batch.cache[key];
  const own = ownTranscriptOf(content);
  const shown = (
    text: string,
    made: string | undefined,
    tokens: PiiTokenMap,
    usage: readonly UsageRecord[],
  ) => ({
    pieces:
      mask === undefined
        ? [textPiece(heading, text, runtime.maxResultSize)]
        : maskedTextPieces(heading, text, runtime.maxResultSize),
    viewed: transcriptFile(content, text),
    ...(made === undefined ? {} : { made: { entry: made, key } }),
    tokens,
    usage,
  });
  if (cached !== undefined) return shown(cached, undefined, {}, []);
  if (own !== undefined && mask === undefined) return shown(own, undefined, {}, []);
  const spent: UsageRecord[] = [];
  let raw = own;
  if (raw === undefined) {
    batch.beforeModelCall();
    const result = await runtime.transcribe(content);
    raw = result.text;
    if (result.usage !== undefined) spent.push(result.usage);
  }
  if (mask === undefined) return shown(raw, raw, {}, spent);
  const masked = await mask.mask(raw, known);
  return shown(masked.text, masked.text, masked.tokens, [...spent, ...masked.usage]);
}

/** One file in one view: its pieces, the file as the model saw it, and what making it cost. */
export async function viewOf(
  batch: FileBatch,
  content: FileContent,
  view: FileView,
  heading: string,
  known: PiiTokenMap,
): Promise<ViewResult> {
  // a text format's own text is text to the policies in any view: masked where it is read (#899 §5)
  const isMaskedText = batch.mask !== undefined && isTextFormat(content.mediaType);
  if (view === FileView.Transcription || isMaskedText)
    return transcriptionOf(batch, content, heading, known);
  if (view === FileView.Redacted)
    return { ...(await redactedViewOf(batch, content, heading)), tokens: {} };
  const pieces = originalPieces(heading, content, batch.runtime.maxResultSize);
  return { pieces, viewed: content, tokens: {}, usage: [] };
}
