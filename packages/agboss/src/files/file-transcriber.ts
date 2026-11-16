import { Injectable } from "../components/decorators.js";
import { lazyLoad } from "../infrastructure/clock.js";
import type { ModelBinding } from "../llm/registry.js";
import type { Usd } from "../units/index.js";
import type { UsageRecord } from "../finops/usage.js";
import type { FileContent } from "./file-bytes.js";

/**
 * Transcribing a file (#899 §6): its content as text, which the agent's PII policies mask like any
 * text. A contract with a built-in on a vision model (`ModelFileTranscriber`, its model set by
 * `defaults.files.transcriptionModel`) and a project's own — an OCR service, a document parser —
 * listed in `@Application({ providers })`, one per application.
 */

/** What one transcription gives: the text, and what it cost. */
export interface TranscriptionResult {
  readonly text: string;
  /** The model call's tokens, for a transcriber that calls one. */
  readonly usage?: UsageRecord;
  /** What a project's own service cost; billed as `CostSource.Tool` under `files:transcriber`. */
  readonly cost?: Usd;
}

/** What a transcription is run under. */
export interface TranscribeOptions {
  readonly signal: AbortSignal;
  readonly tenantId: string;
}

/** The contract of a transcriber: a project's own `extends FileTranscriber`. */
export abstract class FileTranscriber {
  abstract transcribe(file: FileContent, options: TranscribeOptions): Promise<TranscriptionResult>;
}

/** What the built-in does, loaded with its first transcription. */
const work = () => lazyLoad(import("./model-file-transcriber-work.js"));

/**
 * The built-in transcriber: one call to the agent's `transcriptionModel` ("transcribe verbatim,
 * describe non-text content"), bounded by `transcriptionMaxTokens`. The agent's loop hands it the
 * model's binding (`transcribeWith`): it reads the raw file, as `detectWithModel` reads raw text.
 */
@Injectable()
export class ModelFileTranscriber extends FileTranscriber {
  /** @internal Framework wiring: one transcription on `binding`'s model; left out of the declarations. */
  async transcribeWith(
    binding: ModelBinding,
    file: FileContent,
    options: TranscribeOptions,
  ): Promise<TranscriptionResult> {
    return (await work()).transcribed(binding, file, options);
  }

  /** The built-in has no model of its own: its agent's loop calls `transcribeWith`. */
  override transcribe(): Promise<TranscriptionResult> {
    return Promise.reject(
      new TypeError("ModelFileTranscriber transcribes on its agent's model: use transcribeWith"),
    );
  }
}
