/**
 * Which host served a model call (#395 PR 6): a provider's client copies it into the answer's
 * `usage` (OpenRouter's `provider`, by `servedByFetch` in `models/served-by.ts`) under this field.
 */

/** The field of a completion's `usage` that names the host that served it. */
export const SERVED_BY_FIELD = "agboss_served_by";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The host a call's answer names (`response_metadata.usage`), if any. */
export function servedByOf(
  metadata: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  const usage = metadata?.usage;
  if (!isRecord(usage)) return undefined;
  const host = usage[SERVED_BY_FIELD];
  return typeof host === "string" && host !== "" ? host : undefined;
}
