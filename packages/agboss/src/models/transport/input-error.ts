import { AGBossError } from "../../core/errors.js";
import { ModelCallError } from "../circuit-breaker.js";
import type { ModelInputKind } from "../content.js";

/** What a transport that cannot take a part says (#899 §2). */
export interface ModelProviderInputErrorOptions {
  /** The kind of input it cannot take. */
  readonly kind: ModelInputKind;
  /** The media type of the part. */
  readonly mediaType: string;
  readonly cause?: unknown;
}

/**
 * Thrown by `complete(request)` for a part its model or SDK cannot take. Not a `ModelFailure`: those
 * are transient, for `RetryPolicy.retryOn`. The attempt runner turns it at once into `ModelCallError`
 * (`model.unsupported-input`) — never retried, never counted by the breaker: a client's input error
 * must not open a breaker for text calls.
 */
export class ModelProviderInputError extends AGBossError {
  static override readonly code = "model.provider-input" as const;
  declare readonly code: typeof ModelProviderInputError.code;
  readonly kind: ModelInputKind;
  readonly mediaType: string;

  constructor(options: ModelProviderInputErrorOptions) {
    const { kind, mediaType, cause } = options;
    super(`model.provider-input: ${kind} input (${mediaType}) is not taken`, { cause });
    this.kind = kind;
    this.mediaType = mediaType;
  }
}

/** The `ModelCallError` a refused part is for the caller: `model.unsupported-input`, naming the call. */
export function unsupportedInputOf(
  error: ModelProviderInputError,
  call: { readonly provider: string; readonly model: string },
): ModelCallError {
  const { kind, mediaType } = error;
  return new ModelCallError({
    code: "model.unsupported-input",
    ...call,
    kind,
    mediaType,
    message: `${call.model} cannot take a ${kind} part (${mediaType})`,
    cause: error,
  });
}
