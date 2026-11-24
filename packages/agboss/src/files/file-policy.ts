import { recordOptionKeys } from "../components/option-keys.js";
import { FILE_POLICY_KEYS } from "../components/decorator-options.js";
import { DEFAULT_A2A_FILE_MEDIA_TYPES } from "../a2a/files/a2a-file-options.js";
import type { Class } from "../components/injection.js";
import { filePolicyProblemsOf } from "./file-policy-problems.js";
import { poolExcessOf } from "./file-pool-excess.js";
import { callerFile } from "../components/call-site.js";
import { componentOf, recordComponent } from "../components/metadata.js";
import { resolvedName } from "../flow/names.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import { kilobytes, seconds, hours, Ttl, type Bytes, type Milliseconds } from "../units/index.js";
import { ttlExcessOf } from "./file-ttl.js";

/**
 * `@FilePolicy` (#1316): what a workflow's files may be — how many, how large, of which media
 * types, fetched from which origins, how long a fetch may take and how many fetches by url run at
 * once. The one place these limits are set: the A2A skills' input, a step's `Files.save`, an agent's
 * model files and a model's read of a file by url all read the policy of their workflow. A skill's
 * own `filePolicy` may only tighten it (`[a2a.skill-file-policy-exceeds-workflow]`).
 */

/**
 * The bulkhead of fetches of files by url (#1335, #1339). A policy that sets one gets a pool of its
 * own, a policy that sets none shares the application's default pool. Under the total a tenant has
 * its share, and under it each owner (when the execution has one — an ownerless execution uses its
 * tenant's share directly). A fetch over a share waits in a queue of the share's size; past the
 * queue it fails at once with `FileError.Unavailable` (`FileUnavailableReason.FetchBusy`).
 */
export interface FileFetchPool {
  /** Fetches at once, in all (16). A whole number from 1. */
  readonly maxConcurrent?: number | undefined;
  /** Fetches at once of one tenant (a quarter of `maxConcurrent`, at least 1). */
  readonly maxConcurrentPerTenant?: number | undefined;
  /** Fetches at once of one owner inside its tenant (2, at most half the tenant's share, at least 1). */
  readonly maxConcurrentPerOwner?: number | undefined;
  /** Fetches of one owner waiting for a slot (8). A whole number from 1. */
  readonly maxQueuedPerOwner?: number | undefined;
}

/** `@FilePolicy({ … })` options: every field is optional, what a policy leaves out is the built-in's. */
export interface FilePolicyOptions {
  /** Kebab-case; the class name in kebab-case when left out. */
  readonly name?: string;
  readonly description?: string;
  /**
   * How long a file is kept once its execution (its whole tree) has ended — never while it runs
   * (`hours(24)` by default, `Ttl.Forever`: never swept). A workflow's policy must set it
   * (`[file-policy.ttl-required-on-workflow]`); a skill's or an agent's may only be shorter.
   */
  readonly ttl?: Milliseconds | Ttl.Forever;
  /** The most files of one message or one model call (5). */
  readonly maxFiles?: number;
  /** The largest file (`kilobytes(64)`). */
  readonly maxFileSize?: Bytes;
  /** The most bytes of all of one message's or one model call's files (`kilobytes(64)`). */
  readonly maxTotalFileSize?: Bytes;
  /** The media types taken (images, PDF, plain text, Markdown, CSV and JSON). */
  readonly allowedMediaTypes?: readonly string[];
  /** The `https:` origins a file by `url` is fetched from (`https://files.example`); none: no file by url. */
  readonly allowedOrigins?: readonly string[];
  /** How long a file by `url` may take to fetch, redirects and the wait for a slot included (`seconds(10)`). */
  readonly fetchTimeout?: Milliseconds;
  /** The pool its fetches by url run in; left out, the application's shared one. */
  readonly fetchPool?: FileFetchPool;
}

/** What `@FilePolicy` recorded: its options, and the file it is declared in. */
export interface FilePolicyMeta extends FilePolicyOptions {
  readonly name: string;
  readonly source?: string;
}

/** `@FilePolicy({ … })` on an empty class: named by `filePolicy: X` on `@Workflow` and on an A2A skill. */
export function FilePolicy(options: FilePolicyOptions = {}) {
  const source = callerFile();
  return <TClass extends Class>(value: TClass): TClass => {
    recordOptionKeys(value, "FilePolicy", options, FILE_POLICY_KEYS);
    const meta: FilePolicyMeta = { ...options, name: resolvedName(options.name, value) };
    recordComponent(value, {
      kind: "file-policy",
      meta: source === undefined ? meta : { ...meta, source },
    });
    return value;
  };
}

/** A class's `@FilePolicy` options, if it is one. */
export const filePolicyMetaOf = (cls: Class): FilePolicyMeta | undefined => {
  const component = componentOf(cls);
  return component?.kind === "file-policy" ? component.meta : undefined;
};

/**
 * Where a policy's options are read from: the declared ones (`filePolicyMetaOf`), or those the
 * selected profiles leave (`ComponentOptions.filePolicyMetaOf`, #1318c).
 */
export type FilePolicyMetaOf = (policy: Class) => FilePolicyMeta | undefined;

/** What a profile changes of one `@FilePolicy`, by its `name` (`filePolicies: { "<name>": { … } }`). */
export type FilePolicyOverlay = Omit<FilePolicyOptions, "name" | "description">;

/** A policy's options with a profile's overlay on top; the pool merges field by field. */
export const overlaidFilePolicyMeta = (
  meta: FilePolicyMeta,
  overlay: FilePolicyOverlay | undefined,
): FilePolicyMeta =>
  overlay === undefined
    ? meta
    : {
        ...meta,
        ...overlay,
        ...(overlay.fetchPool === undefined
          ? {}
          : { fetchPool: { ...meta.fetchPool, ...overlay.fetchPool } }),
      };

/** The limits a file runs with: every field set. */
export interface FileLimits {
  readonly ttl: Milliseconds | Ttl.Forever;
  readonly maxFileSize: Bytes;
  readonly maxTotalFileSize: Bytes;
  readonly maxFiles: number;
  readonly allowedMediaTypes: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly fetchTimeout: Milliseconds;
  /** The policy's own pool; `undefined`: the application's shared one. */
  readonly fetchPool: FileFetchPool | undefined;
}

/** How long a file by `url` may take to fetch by default. */
export const DEFAULT_FILE_FETCH_TIMEOUT: Milliseconds = seconds(10);

/** The limits of a workflow with no `filePolicy` set: every file past them is refused. */
export const DEFAULT_FILE_LIMITS: FileLimits = Object.freeze({
  ttl: hours(24),
  maxFileSize: kilobytes(64),
  maxTotalFileSize: kilobytes(64),
  maxFiles: 5,
  allowedMediaTypes: DEFAULT_A2A_FILE_MEDIA_TYPES,
  allowedOrigins: [],
  fetchTimeout: DEFAULT_FILE_FETCH_TIMEOUT,
  fetchPool: undefined,
});

const LIMIT_FIELDS = [
  "ttl",
  "maxFileSize",
  "maxTotalFileSize",
  "maxFiles",
  "allowedMediaTypes",
  "allowedOrigins",
  "fetchTimeout",
  "fetchPool",
] as const;

/** What a policy sets, as plain data (what rides a workflow's config): the fields it gives. */
const setOf = (meta: FilePolicyMeta | undefined): Partial<FileLimits> =>
  Object.fromEntries(
    LIMIT_FIELDS.flatMap((field) => {
      const value: unknown = meta?.[field];
      return value === undefined ? [] : [[field, value] as const];
    }),
  );

/**
 * The limits of a chain of policies, the outermost first (a workflow's, then its skill's): each
 * later one's fields over the earlier ones', over the built-ins. A class that is no `@FilePolicy`
 * sets nothing (the assembly rules refuse it).
 */
export const fileLimitsUnder = (
  metaOf: FilePolicyMetaOf,
  ...chain: readonly (Class | undefined)[]
): FileLimits =>
  chain.reduce<FileLimits>(
    (limits, policy) => ({
      ...limits,
      ...setOf(policy === undefined ? undefined : metaOf(policy)),
    }),
    DEFAULT_FILE_LIMITS,
  );

/** The limits of a chain of policies as declared; what runs under profiles asks `ComponentOptions`. */
export const fileLimitsOf = (...chain: readonly (Class | undefined)[]): FileLimits =>
  fileLimitsUnder(filePolicyMetaOf, ...chain);

/** `[file-policy.invalid]` of one policy class; `[file-policy.not-a-file-policy]` when it is none. */
export function filePolicyViolations(
  where: string,
  policy: Class | undefined,
  nodes: readonly string[],
  metaOf: FilePolicyMetaOf = filePolicyMetaOf,
): RuleViolation[] {
  if (policy === undefined) return [];
  const meta = metaOf(policy);
  if (meta === undefined)
    return [
      violation(
        "file-policy.not-a-file-policy",
        `${where}: ${policy.name} is not a @FilePolicy class — decorate it with @FilePolicy()`,
        nodes,
      ),
    ];
  return filePolicyProblemsOf(meta).map((problem) =>
    violation("file-policy.invalid", `${where}: ${meta.name}: ${problem}`, nodes),
  );
}

/** How a narrower policy exceeds its parent's, each a text; none when it only tightens. */
function exceedsOf(parent: FileLimits, child: FileLimits): readonly string[] {
  const numbers = (
    ["maxFileSize", "maxTotalFileSize", "maxFiles", "fetchTimeout"] as const
  ).flatMap((field) =>
    child[field] > parent[field]
      ? [`${field} ${String(child[field])} is above ${String(parent[field])}`]
      : [],
  );
  const types = child.allowedMediaTypes
    .filter((type) => !parent.allowedMediaTypes.includes(type))
    .map((type) => `allowedMediaTypes has ${type}, which it does not`);
  const origins = child.allowedOrigins
    .filter((origin) => !parent.allowedOrigins.includes(origin))
    .map((origin) => `allowedOrigins has ${origin}, which it does not`);
  return [
    ...numbers,
    ...ttlExcessOf(parent.ttl, child.ttl),
    ...poolExcessOf(parent.fetchPool, child.fetchPool),
    ...types,
    ...origins,
  ];
}

/**
 * What `child` — a policy that narrows `parent`'s, a skill's under its workflow's — sets beyond it:
 * a narrower policy only tightens, never widens.
 */
export function filePolicyExcesses(
  parent: Class | undefined,
  child: Class,
  metaOf: FilePolicyMetaOf = filePolicyMetaOf,
): readonly string[] {
  if (metaOf(child) === undefined) return [];
  return exceedsOf(fileLimitsUnder(metaOf, parent), fileLimitsUnder(metaOf, parent, child));
}

export { filePolicyProblemsOf };
