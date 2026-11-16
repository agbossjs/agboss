import { Injectable } from "../components/decorators.js";
import { lazyLoad } from "../infrastructure/clock.js";
import type { ModelBinding } from "../llm/registry.js";
import type { UsageRecord } from "../finops/usage.js";
import type { PiiTarget } from "../pii/kinds.js";
import type { Usd } from "../units/index.js";
import type { FileContent } from "./file-bytes.js";

/**
 * Redacting a file (#899 §5, §6): a copy of it with every personal datum a policy names blacked out.
 * A contract with a built-in for images on a vision model (`ModelImageRedactor`, its model set by
 * `defaults.files.redactionModel`) and a project's own — Presidio Image, a document service — listed in
 * `@Application({ providers })`, one per application. Where no redactor `supports` a file's type there is
 * no redacted view of it (`[files.no-redactor]` at start).
 */

/** What a redaction is asked to hide, and under what. */
export interface RedactOptions {
  /** The kinds to black out: what the agent's PII policies' rules name. */
  readonly targets: readonly PiiTarget[];
  /** The execution's sensitive context values: black these out wherever they appear. */
  readonly values: readonly string[];
  readonly signal: AbortSignal;
  readonly tenantId: string;
}

/** What a redaction is asked to hide: the kinds and values, before the call's own signal and tenant are set. */
export type RedactionPlan = Pick<RedactOptions, "targets" | "values">;

/** What one redaction gives. */
export interface RedactionResult {
  /** The file with its personal data blacked out: the same media type. */
  readonly file: FileContent;
  /** The targets it found in the original. A block rule's target found refuses the file. */
  readonly found: readonly PiiTarget[];
  /** The model call's tokens, for a redactor that calls one. */
  readonly usage?: UsageRecord;
  /** What a project's own service cost; billed as `CostSource.Tool` under `files:redactor`. */
  readonly cost?: Usd;
}

/**
 * The contract of a redactor: a project's own `extends FileRedactor`. `supports` is asked at start, on the
 * class, before any instance exists: it answers from the media type alone.
 */
export abstract class FileRedactor {
  abstract supports(mediaType: string): boolean;
  abstract redact(file: FileContent, options: RedactOptions): Promise<RedactionResult>;
}

/** The media types the built-in redactor makes a copy of: what it re-encodes (png, jpeg, webp). */
export const BUILT_IN_REDACTED_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp"];

/** What the built-in does, loaded with its first redaction (`sharp` is loaded there). */
const work = () => lazyLoad(import("./model-image-redactor-work.js"));

/**
 * The built-in redactor of images: one call to the agent's `redactionModel` for the regions that hold
 * the targets, then a copy of the image, its EXIF orientation applied and its metadata gone, with those
 * regions blacked out. `sharp` is an optional peer dependency: the built-in needs it, a project with its
 * own redactor does not. Any failure fails closed (`FileRedactionFailedError`): never the unredacted file.
 */
@Injectable()
export class ModelImageRedactor extends FileRedactor {
  /** @internal Framework wiring: one redaction on `binding`'s model; left out of the declarations. */
  async redactWith(
    binding: ModelBinding,
    agent: string,
    file: FileContent,
    options: RedactOptions,
  ): Promise<RedactionResult> {
    return (await work()).redacted(binding, agent, file, options);
  }

  override supports(mediaType: string): boolean {
    return BUILT_IN_REDACTED_TYPES.includes(mediaType);
  }

  /** The built-in has no model of its own: its agent's loop calls `redactWith`. */
  override redact(): Promise<RedactionResult> {
    return Promise.reject(
      new TypeError("ModelImageRedactor redacts on its agent's model: use redactWith"),
    );
  }
}
