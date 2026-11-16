import { ModelCallError } from "../circuit-breaker.js";
import type { ModelInputKind } from "../content.js";

/**
 * A provider's 4xx that says the model cannot take an input (#899 §2): OpenRouter answers `404`
 * "No endpoints found that support image input" / "…input modalities: image", other
 * OpenAI-compatible servers a `400` with an `unsupported_*` code. It is the same
 * `model.unsupported-input` a transport's `ModelProviderInputError` is: the caller's input is wrong,
 * the provider is well — never retried, never counted by the breaker.
 */

const REFUSING_STATUSES = new Set([400, 404, 422]);

const NAMES: readonly (readonly [RegExp, ModelInputKind])[] = [
  [/\bimages?\b/i, "image"],
  [/\baudio\b/i, "audio"],
  [/\bvideo\b/i, "video"],
  [/\b(?:pdf|files?|documents?)\b/i, "file"],
];

const SAYS_INPUT =
  /(?:support|accept|take)s?[^."]{0,60}\binput|input[ _-]modalit|modalit[^."]{0,40}(?:not|un)[^."]{0,20}support|unsupported[_ -](?:input|modalit|content)/i;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What an error body says: its message and its code, as one text. */
function sayingOf(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    const error = isRecord(parsed) ? parsed.error : undefined;
    if (!isRecord(error)) return "";
    const { message, code, type } = error;
    return [message, code, type].filter((part) => typeof part === "string").join(" ");
  } catch {
    return "";
  }
}

/** The kind of input an error body says the model cannot take; `undefined` when it says no such thing. */
export function refusedKindOf(status: number, body: string): ModelInputKind | undefined {
  if (!REFUSING_STATUSES.has(status)) return undefined;
  const saying = sayingOf(body);
  if (!SAYS_INPUT.test(saying)) return undefined;
  return NAMES.find(([pattern]) => pattern.test(saying))?.[1] ?? "file";
}

/** The media type of the first part of that kind in the request that was sent (a data URL's). */
function mediaTypeSentOf(request: string, kind: ModelInputKind): string {
  const field =
    kind === "image" ? /"url":"data:([^;"]+);base64/ : /"file_data":"data:([^;"]+);base64/;
  return field.exec(request)?.[1] ?? "unknown";
}

/** What is known of the call a refusal answers. */
export interface RefusedCall {
  readonly provider: string;
  /** The request body as it was sent. */
  readonly body: string | undefined;
}

/** The `ModelCallError` of a refused input, from the response of the call that was sent; none for any other response. */
export async function refusalOfResponse(
  response: Response,
  call: RefusedCall,
): Promise<ModelCallError | undefined> {
  if (!REFUSING_STATUSES.has(response.status)) return undefined;
  const kind = refusedKindOf(response.status, await response.clone().text());
  if (kind === undefined) return undefined;
  const sent = call.body ?? "";
  const mediaType = mediaTypeSentOf(sent, kind);
  const model = /"model":"([^"]+)"/.exec(sent)?.[1] ?? "";
  return new ModelCallError({
    code: "model.unsupported-input",
    provider: call.provider,
    model,
    kind,
    mediaType,
    message: `${model} cannot take a ${kind} part (${mediaType}): the provider refused it`,
  });
}
