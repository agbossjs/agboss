import type { Clock } from "../../infrastructure/clock.js";
import { downloadedFile, type A2ADownloadOptions, type FileDto } from "./a2a-download.js";
import type { Class } from "../../components/injection.js";
import { fileLimitsOf } from "../../files/file-policy.js";
import { appFileSlotsOf } from "../files/a2a-file-pool.js";
import type { Bytes, Milliseconds } from "../../units/index.js";
import type { FileFetchSlots } from "../files/a2a-file-slots.js";

/**
 * What bounds a standalone client's `downloadFile` (#1316): its own pool of downloads (the
 * `@FilePolicy`'s `fetchPool`, else the default 16 / 4 / 2 + 8 — one per client, not the
 * application's), and, when a `filePolicy` is configured, its `maxFileSize` (never above the call's
 * `maxSize`) and `fetchTimeout`. An oversized download fails closed: the read stops at the first byte
 * past the cap.
 */
export function boundsOf(
  client: object,
  policy: Class | undefined,
  maxSize: Bytes | undefined,
): { readonly slots: FileFetchSlots; readonly maxSize?: Bytes; readonly timeout?: Milliseconds } {
  if (policy === undefined) return { slots: appFileSlotsOf(client), ...cap(maxSize) };
  const limits = fileLimitsOf(policy);
  const cap_ = Math.min(limits.maxFileSize, maxSize ?? limits.maxFileSize) as Bytes;
  return {
    slots: appFileSlotsOf(client, limits.fetchPool),
    maxSize: cap_,
    timeout: limits.fetchTimeout,
  };
}

const cap = (maxSize: Bytes | undefined): { readonly maxSize?: Bytes } =>
  maxSize === undefined ? {} : { maxSize };

/** `downloadFile`: the file's bytes within the client's bounds (its pool, its policy's size and time). */
export function downloadedBy(
  client: object,
  file: FileDto,
  options: A2ADownloadOptions | undefined,
  using: readonly [typeof fetch, Pick<Clock, "sleep">, Class | undefined],
): Promise<Uint8Array> {
  const [fetcher, clock, policy] = using;
  return downloadedFile(file, {
    ...options,
    ...boundsOf(client, policy, options?.maxSize),
    fetcher,
    clock,
  });
}
