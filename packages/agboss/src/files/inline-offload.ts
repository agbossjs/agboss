import type { Class } from "../components/injection.js";
import { isFileDescriptor } from "../a2a/files/a2a-file-scrub.js";
import type { FileDto } from "../dto/standard/file.js";
import { currentFrame, rootFactsOf } from "../flow/context/frame.js";
import { systemClock, type Clock } from "../infrastructure/clock.js";
import { FileRepository } from "../infrastructure/file.repository.js";
import { Ttl } from "../units/index.js";
import { fileLimitsOf } from "./file-policy.js";
import { assertInlineFits, offloadedInlineFiles } from "./inline-cap.js";
import { workflowFilePolicyOf } from "./workflow-file-policy.js";

/**
 * The inline cap at the places a payload enters an execution (#1316): the run's input, a pause's
 * answer, a tool's output. Each walks its value for descriptors, whatever DTO holds them, and brings
 * the inline bytes under the 64 KB / 256 KB caps: offloaded to the file store, owned by the root
 * execution, or — with no store listed — refused with `FileRefusal.InlineTooLarge`.
 */

/** How deep a value is walked; a value nested deeper than a DTO can be is not a payload. */
const MAX_DEPTH = 64;

/** The file descriptors a value holds at any depth, in order: DTO instances, lists and plain records. */
function fileDescriptorsIn(value: unknown, depth = 0): readonly FileDto[] {
  if (depth > MAX_DEPTH || typeof value !== "object" || value === null) return [];
  if (isFileDescriptor(value)) return [value];
  const items: unknown[] = Array.isArray(value) ? value : Object.values(value);
  return items.flatMap((item) => fileDescriptorsIn(item, depth + 1));
}

/** Whose payload it is: the tenant and the root execution its files belong to. */
export interface InlineSite {
  readonly tenantId: string;
  readonly ownerId: string;
}

/** What keeps a payload's inline bytes under the caps. */
export interface InlineFiles {
  /** Refuses at once when the store keeps nothing and the value is over a cap; writes nothing. */
  readonly check: (value: unknown) => void;
  /** Offloads what is over the caps, in place: the descriptors hold a `fileId` instead of `inline`. */
  readonly offload: (value: unknown, site: InlineSite) => Promise<void>;
  /** `offload` for a run that is new: one that fails leaves no file of the run behind. */
  readonly offloadNew: (value: unknown, site: InlineSite) => Promise<void>;
}

/** A workflow's `@FilePolicy.ttl` as an offloaded file's own: none for ever. */
function policyTtlOf(workflow: Class | undefined) {
  const { ttl } = fileLimitsOf(workflowFilePolicyOf(workflow));
  return ttl === Ttl.Forever ? undefined : ttl;
}

/** The caps over the application's file store (read when first needed), for payloads of `workflow`. */
export function inlineFilesOf(
  store: () => FileRepository,
  clock: Pick<Clock, "now">,
  workflow: Class | undefined,
): InlineFiles {
  const offload = (value: unknown, site: InlineSite) =>
    offloadedInlineFiles(fileDescriptorsIn(value), {
      store: store(),
      ...site,
      now: clock.now(),
      ttl: policyTtlOf(workflow),
    });
  return {
    offload,
    offloadNew: (value, site) =>
      offload(value, site).catch(async (error: unknown) => {
        await store().deleteByOwner(site);
        throw error;
      }),
    check: (value) => {
      assertInlineFits(fileDescriptorsIn(value), store());
    },
  };
}

/** A tool's output held to the caps: its files owned by the root execution the call runs in. */
export function toolInlineFilesOf(deps: {
  readonly container: { readonly get: <T>(token: Class<T>) => T };
  readonly clock?: Pick<Clock, "now"> | undefined;
}): (value: unknown) => Promise<void> {
  return async (value) => {
    const execution = currentFrame()?.execution;
    if (execution === undefined) return;
    await inlineFilesOf(
      () => deps.container.get(FileRepository),
      deps.clock ?? systemClock,
      execution.workflow.type,
    ).offload(value, {
      tenantId: execution.tenant.tenantId,
      ownerId: rootFactsOf(execution).executionId,
    });
  };
}
