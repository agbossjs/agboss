import type { UsageRecord } from "../finops/usage.js";
import type { GuardedFile } from "../guardrails/guarded-text.js";
import type { Bytes } from "../units/index.js";
import type { FileMask } from "./file-mask.js";
import { originalPieces, type FilePiece } from "./file-pieces.js";
import type { ViewedFile } from "./visit-files.js";

/**
 * The files a guardrail checks (#899 §8): each file in each view the agent's model got, as the file and
 * as the pieces it is sent as — a transcription as its masked text, an image or a PDF as a part. Never
 * the bytes as text: no LLM guardrail is shown base64. Where PII policies apply, every text a guardrail's
 * model reads — a heading, a file name — is masked as the agent's model reads it.
 */

/** The guarded files and what masking their headings and names cost. */
export interface GuardedFiles {
  readonly files: readonly GuardedFile[];
  readonly usage: readonly UsageRecord[];
}

async function maskedPiece(
  piece: FilePiece,
  mask: FileMask,
  spent: UsageRecord[],
): Promise<FilePiece> {
  // the original's pieces (`originalPieces`: never a masked text): a text is masked, a file part's name is
  switch (piece.kind) {
    case "text": {
      const masked = await mask.mask(piece.text, mask.known);
      spent.push(...masked.usage);
      return { ...piece, text: masked.text };
    }
    case "file": {
      if (piece.filename === undefined) return piece;
      const masked = await mask.mask(piece.filename, mask.known);
      spent.push(...masked.usage);
      return { ...piece, filename: masked.text };
    }
    default:
      return piece;
  }
}

export async function guardedFilesOf(
  viewed: readonly ViewedFile[],
  maxResultSize: Bytes,
  mask?: FileMask,
): Promise<GuardedFiles> {
  const spent: UsageRecord[] = [];
  const files: GuardedFile[] = [];
  for (const { content, heading } of viewed) {
    const pieces = originalPieces(heading, content, maxResultSize);
    if (mask === undefined) {
      files.push({ content, pieces });
      continue;
    }
    const masked: FilePiece[] = [];
    for (const piece of pieces) masked.push(await maskedPiece(piece, mask, spent));
    const name =
      content.filename === undefined ? undefined : await mask.mask(content.filename, mask.known);
    spent.push(...(name?.usage ?? []));
    files.push({
      content: name === undefined ? content : { ...content, filename: name.text },
      pieces: masked,
    });
  }
  return { files, usage: spent };
}
