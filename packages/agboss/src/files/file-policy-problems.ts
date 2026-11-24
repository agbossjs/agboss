import { mediaTypeEssenceOf } from "../a2a/files/a2a-file-options.js";
import { MAX_TIMEOUT, timerProblemOf } from "../units/timer-limits.js";
import { ttlProblemsOf } from "./file-ttl.js";
import type { FileFetchPool, FilePolicyOptions } from "./file-policy.js";

/** What is wrong with a `@FilePolicy`'s options, each a text (`[file-policy.invalid]`). */

const isWhole = (value: unknown, min: number): boolean =>
  typeof value === "number" && Number.isInteger(value) && value >= min;

/** An allowed origin is written as `new URL(…).origin` writes it, on `https:`. */
const isHttpsOrigin = (entry: string): boolean =>
  URL.canParse(entry) && new URL(entry).origin === entry && entry.startsWith("https://");

/** What is wrong with the sizes and the count of one policy. */
function limitProblemsOf(options: FilePolicyOptions): readonly string[] {
  const sizes = (["maxFileSize", "maxTotalFileSize"] as const).flatMap((field) =>
    options[field] === undefined || isWhole(options[field], 1)
      ? []
      : [`${field} is not a whole number of bytes from 1`],
  );
  const count =
    options.maxFiles === undefined || isWhole(options.maxFiles, 1)
      ? []
      : ["maxFiles is not a whole number from 1"];
  const cap =
    options.fetchTimeout === undefined
      ? undefined
      : timerProblemOf("fetchTimeout", options.fetchTimeout, MAX_TIMEOUT);
  const timeout =
    options.fetchTimeout === undefined
      ? []
      : cap !== undefined
        ? [cap]
        : isWhole(options.fetchTimeout, 1)
          ? []
          : ["fetchTimeout is not a whole number of milliseconds from 1"];
  return [...sizes, ...count, ...timeout, ...ttlProblemsOf(options.ttl)];
}

/** What is wrong with the media types and origins of one policy. */
function listProblemsOf(options: FilePolicyOptions): readonly string[] {
  const types = (options.allowedMediaTypes ?? []).flatMap((type) =>
    mediaTypeEssenceOf(type) === type && type.includes("/")
      ? []
      : [`allowedMediaTypes entry "${type}" is not a lower-case type/subtype`],
  );
  const origins = (options.allowedOrigins ?? []).flatMap((origin) =>
    isHttpsOrigin(origin)
      ? []
      : [`allowedOrigins entry "${origin}" is not an https: origin (no path)`],
  );
  return [...types, ...origins];
}

const POOL_FIELDS = [
  "maxConcurrent",
  "maxConcurrentPerTenant",
  "maxConcurrentPerOwner",
  "maxQueuedPerOwner",
] as const;

/** What is wrong with a policy's pool: a field that is no whole number from 1. */
function poolProblemsOf(pool: FileFetchPool | undefined): readonly string[] {
  if (pool === undefined) return [];
  return POOL_FIELDS.flatMap((field) =>
    pool[field] === undefined || isWhole(pool[field], 1)
      ? []
      : [`fetchPool.${field} is not a whole number from 1`],
  );
}

/** What is wrong with the size limits taken together: a file never larger than the total, when both are set. */
function orderProblemsOf(options: FilePolicyOptions): readonly string[] {
  const { maxFileSize, maxTotalFileSize } = options;
  return maxFileSize !== undefined &&
    maxTotalFileSize !== undefined &&
    maxFileSize > maxTotalFileSize
    ? ["maxFileSize is larger than maxTotalFileSize"]
    : [];
}

/** What is wrong with one policy, each a text. */
export const filePolicyProblemsOf = (options: FilePolicyOptions): readonly string[] => [
  ...limitProblemsOf(options),
  ...listProblemsOf(options),
  ...poolProblemsOf(options.fetchPool),
  ...orderProblemsOf(options),
];
